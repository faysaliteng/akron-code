#!/usr/bin/env node
/**
 * Pure Node zero-dependency GitHub Release auto-updater for Akron Browser Bot.
 * Usage:
 *   node tools/update.mjs [--check] [--json] [--dir <path>] [--channel stable|prerelease] [--token <pat>] [--base-url <url>]
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  GITHUB_REPO,
  checkForExtensionUpdate,
  parseSha256Sums,
} from "../shared/updater.js";

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PRESERVED_TOP_ENTRIES = new Set([
  ".git",
  ".github",
  ".gitignore",
  ".gitattributes",
  "local-provider.json",
  "release",
  "tests",
  "node_modules",
  "HOW_TO_INSTALL.txt",
]);

function shouldPreserveRel(rel) {
  const norm = String(rel || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!norm) return true;
  const top = norm.split("/")[0];
  if (PRESERVED_TOP_ENTRIES.has(top)) return true;
  if (/\.pem$/i.test(norm) || /\.crx$/i.test(norm) || /\.zip$/i.test(norm) || /\.local\.md$/i.test(norm)) {
    return true;
  }
  return false;
}

export function resolveGithubToken(explicitToken = "") {
  const direct = String(explicitToken || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "").trim();
  if (direct) return direct;
  try {
    const out = execFileSync("gh", ["auth", "token"], { encoding: "utf8", timeout: 2500, stdio: ["ignore", "pipe", "ignore"] });
    return String(out || "").trim();
  } catch {
    return "";
  }
}

export function readInstalledVersion(targetDir = DEFAULT_ROOT) {
  const manifestPath = path.join(targetDir, "manifest.json");
  const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  return String(raw.version || "0.0.0").trim();
}

/**
 * Inflate a ZIP buffer safely into memory entries, blocking path traversal.
 * @param {Buffer} zipBuf
 */
export function extractZipEntries(zipBuf) {
  if (!Buffer.isBuffer(zipBuf) || zipBuf.length < 22) {
    throw new Error("Invalid ZIP archive (buffer too small).");
  }
  let eocdOffset = -1;
  const minOffset = Math.max(0, zipBuf.length - 65557);
  for (let i = zipBuf.length - 22; i >= minOffset; i--) {
    if (zipBuf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error("Invalid ZIP archive (End of Central Directory missing).");

  const totalEntries = zipBuf.readUInt16LE(eocdOffset + 10);
  const cdOffset = zipBuf.readUInt32LE(eocdOffset + 16);
  if (cdOffset >= zipBuf.length) throw new Error("Invalid ZIP Central Directory offset.");

  const entries = [];
  let pos = cdOffset;
  for (let idx = 0; idx < totalEntries; idx++) {
    if (pos + 46 > zipBuf.length || zipBuf.readUInt32LE(pos) !== 0x02014b50) {
      throw new Error("Corrupt ZIP Central Directory header.");
    }
    const compression = zipBuf.readUInt16LE(pos + 10);
    const compSize = zipBuf.readUInt32LE(pos + 20);
    const uncompSize = zipBuf.readUInt32LE(pos + 24);
    const nameLen = zipBuf.readUInt16LE(pos + 28);
    const extraLen = zipBuf.readUInt16LE(pos + 30);
    const commentLen = zipBuf.readUInt16LE(pos + 32);
    const localHeaderOffset = zipBuf.readUInt32LE(pos + 42);
    const rawName = zipBuf.subarray(pos + 46, pos + 46 + nameLen).toString("utf8");
    pos += 46 + nameLen + extraLen + commentLen;

    const cleanName = path.posix.normalize(rawName.replace(/\\/g, "/")).replace(/^\/+/, "");
    if (!cleanName || cleanName === "." || cleanName.startsWith("..") || path.posix.isAbsolute(cleanName)) {
      throw new Error(`Unsafe ZIP entry path rejected: ${rawName}`);
    }
    if (cleanName.endsWith("/")) continue;

    if (localHeaderOffset + 30 > zipBuf.length || zipBuf.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw new Error(`Corrupt local header for ${cleanName}`);
    }
    const lNameLen = zipBuf.readUInt16LE(localHeaderOffset + 26);
    const lExtraLen = zipBuf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + lNameLen + lExtraLen;
    const compData = zipBuf.subarray(dataStart, dataStart + compSize);

    let data;
    if (compression === 0) data = Buffer.from(compData);
    else if (compression === 8) data = zlib.inflateRawSync(compData);
    else throw new Error(`Unsupported ZIP compression method ${compression} on ${cleanName}`);

    if (data.length !== uncompSize) {
      throw new Error(`Size mismatch inflating ${cleanName}: expected ${uncompSize}, got ${data.length}`);
    }
    entries.push({ path: cleanName, data });
  }
  return entries;
}

async function fetchBinaryAsset({ url, apiUrl = "", token = "", fetchImpl = globalThis.fetch }) {
  const cleanToken = String(token || "").trim();
  if (cleanToken && apiUrl) {
    const res = await fetchImpl(apiUrl, {
      headers: {
        Authorization: `Bearer ${cleanToken}`,
        Accept: "application/octet-stream",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (res.ok) return Buffer.from(await res.arrayBuffer());
  }
  const headers = cleanToken ? { Authorization: `Bearer ${cleanToken}` } : {};
  const res = await fetchImpl(url, { headers });
  if (!res.ok) throw new Error(`Failed to download ${url} (HTTP ${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

async function fetchTextOptional({ url, apiUrl = "", token = "", fetchImpl = globalThis.fetch }) {
  if (!url && !apiUrl) return "";
  try {
    const buf = await fetchBinaryAsset({ url, apiUrl, token, fetchImpl });
    return buf.toString("utf8");
  } catch {
    return "";
  }
}

export async function checkUpdateCli(opts = {}) {
  const targetDir = path.resolve(opts.dir || DEFAULT_ROOT);
  const currentVersion = readInstalledVersion(targetDir);
  const token = resolveGithubToken(opts.token);
  return checkForExtensionUpdate({
    currentVersion,
    repo: opts.repo || GITHUB_REPO,
    channel: opts.channel || "stable",
    token,
    baseUrl: opts.baseUrl || process.env.AKRON_UPDATE_BASE_URL || "",
    fetchImpl: opts.fetchImpl || globalThis.fetch,
  });
}

export async function runSelfUpdate(opts = {}) {
  const targetDir = path.resolve(opts.dir || DEFAULT_ROOT);
  const currentVersion = readInstalledVersion(targetDir);
  const token = resolveGithubToken(opts.token);
  const fetchImpl = opts.fetchImpl || globalThis.fetch;

  const check = await checkForExtensionUpdate({
    currentVersion,
    repo: opts.repo || GITHUB_REPO,
    channel: opts.channel || "stable",
    token,
    baseUrl: opts.baseUrl || process.env.AKRON_UPDATE_BASE_URL || "",
    fetchImpl,
  });
  if (!check.ok) return check;
  if (!check.updateAvailable && !opts.force) {
    return { ...check, updated: false, targetDir, message: `Already up to date (v${currentVersion}).` };
  }

  const rel = check.release;
  if (!rel?.zipUrl && !rel?.zipApiUrl) {
    return { ...check, ok: false, updated: false, error: "Release does not contain an AkronBrowserBot ZIP asset." };
  }

  const zipBuf = await fetchBinaryAsset({
    url: rel.zipUrl,
    apiUrl: rel.zipApiUrl,
    token,
    fetchImpl,
  });

  // Verify SHA-256 against latest.json map and/or SHA256SUMS.txt
  const expectedFromMap = String(rel.sha256?.[rel.zipName] || "").toLowerCase();
  const sumsText = await fetchTextOptional({
    url: rel.sumsUrl,
    apiUrl: rel.sumsApiUrl,
    token,
    fetchImpl,
  });
  const sumsMap = parseSha256Sums(sumsText);
  const expectedFromSums = String(sumsMap[rel.zipName] || "").toLowerCase();
  const expectedSha = expectedFromMap || expectedFromSums;
  const actualSha = crypto.createHash("sha256").update(zipBuf).digest("hex").toLowerCase();
  if (expectedSha && actualSha !== expectedSha) {
    throw new Error(`SHA-256 verification failed for ${rel.zipName}: expected ${expectedSha}, got ${actualSha}`);
  }
  if (opts.requireChecksum && !expectedSha) {
    throw new Error(`Checksum missing for ${rel.zipName}`);
  }

  const entries = extractZipEntries(zipBuf);
  const manifestEntry = entries.find((e) => e.path === "manifest.json");
  if (!manifestEntry) throw new Error("Downloaded ZIP is missing manifest.json.");
  const nextManifest = JSON.parse(manifestEntry.data.toString("utf8"));

  // Preserve manifest key if targetDir already carried one for fixed extension IDs.
  try {
    const prevManifest = JSON.parse(fs.readFileSync(path.join(targetDir, "manifest.json"), "utf8"));
    if (prevManifest.key && !nextManifest.key) {
      nextManifest.key = prevManifest.key;
      manifestEntry.data = Buffer.from(JSON.stringify(nextManifest, null, 2) + "\n", "utf8");
    }
  } catch {}

  let filesWritten = 0;
  for (const entry of entries) {
    if (shouldPreserveRel(entry.path)) continue;
    const outPath = path.resolve(targetDir, entry.path);
    if (!outPath.startsWith(targetDir + path.sep)) {
      throw new Error(`Refusing path outside targetDir: ${entry.path}`);
    }
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const tmpPath = `${outPath}.upd-${process.pid}`;
    fs.writeFileSync(tmpPath, entry.data);
    fs.renameSync(tmpPath, outPath);
    filesWritten++;
  }

  return {
    ok: true,
    updated: true,
    via: check.via,
    currentVersion,
    latestVersion: String(nextManifest.version || check.latestVersion),
    targetDir,
    filesWritten,
    sha256: actualSha,
    shaVerified: !!expectedSha,
  };
}

function parseArgs(argv) {
  const opts = { check: false, json: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") opts.check = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--force") opts.force = true;
    else if (a === "--dir") opts.dir = argv[++i];
    else if (a === "--repo") opts.repo = argv[++i];
    else if (a === "--channel") opts.channel = argv[++i];
    else if (a === "--token") opts.token = argv[++i];
    else if (a === "--base-url") opts.baseUrl = argv[++i];
  }
  return opts;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const opts = parseArgs(process.argv.slice(2));
  try {
    const result = opts.check ? await checkUpdateCli(opts) : await runSelfUpdate(opts);
    if (opts.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } else if (!result.ok) {
      process.stderr.write(`Update error: ${result.error || "unknown error"}\n`);
      process.exitCode = 1;
    } else if (opts.check) {
      process.stdout.write(
        result.updateAvailable
          ? `Update available: v${result.currentVersion} -> v${result.latestVersion} (${result.release?.htmlUrl || ""})\n`
          : `Akron Browser Bot is up to date (v${result.currentVersion}).\n`
      );
    } else if (result.updated) {
      process.stdout.write(
        `Updated Akron Browser Bot v${result.currentVersion} -> v${result.latestVersion} in ${result.targetDir} (${result.filesWritten} files).\n`
      );
    } else {
      process.stdout.write(`${result.message || "Already up to date."}\n`);
    }
  } catch (e) {
    if (opts.json) process.stdout.write(JSON.stringify({ ok: false, error: String(e?.message || e) }, null, 2) + "\n");
    else process.stderr.write(`Update failed: ${e?.message || e}\n`);
    process.exitCode = 1;
  }
}
