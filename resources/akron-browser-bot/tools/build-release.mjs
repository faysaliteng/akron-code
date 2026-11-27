#!/usr/bin/env node
/**
 * Zero-dependency release packager for Akron Browser Bot.
 * Produces into release/:
 *   - AkronBrowserBot-<ver>.zip
 *   - AkronBrowserBot-<ver>.crx (CRX3 signed with RSA-2048 + SHA-256 + update_url)
 *   - updates.xml (Chrome / Edge / Brave Omaha v2.0 update manifest)
 *   - latest.json (GitHub Releases auto-update descriptor)
 *   - SHA256SUMS.txt
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { GITHUB_REPO, UPDATES_XML_URL } from "../shared/updater.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const EXCLUDED_TOP = new Set([
  ".git",
  ".github",
  ".gitignore",
  ".gitattributes",
  "local-provider.json",
  "release",
  "dist",
  "screenshots",
  "tests",
  "node_modules",
]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function uint16LE(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n & 0xffff, 0);
  return b;
}

function uint32LE(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

function encodeVarint(num) {
  const bytes = [];
  let n = Number(num) >>> 0;
  while (n >= 0x80) {
    bytes.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  bytes.push(n & 0x7f);
  return Buffer.from(bytes);
}

function encodeBytesField(fieldNumber, payload) {
  return Buffer.concat([
    encodeVarint((fieldNumber << 3) | 2),
    encodeVarint(payload.length),
    payload,
  ]);
}

function readVarint(buf, offset) {
  let result = 0;
  let shift = 0;
  let pos = offset;
  while (pos < buf.length) {
    const byte = buf[pos++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: result >>> 0, nextOffset: pos };
    shift += 7;
    if (shift > 35) break;
  }
  throw new Error("Malformed protobuf varint");
}

function parseProtoFields(buf) {
  const fields = [];
  let pos = 0;
  while (pos < buf.length) {
    const tag = readVarint(buf, pos);
    pos = tag.nextOffset;
    const fieldNumber = tag.value >>> 3;
    const wireType = tag.value & 0x07;
    if (wireType !== 2) throw new Error(`Unsupported protobuf wire type ${wireType}`);
    const len = readVarint(buf, pos);
    pos = len.nextOffset;
    const end = pos + len.value;
    if (end > buf.length) throw new Error("Truncated protobuf field");
    fields.push({ fieldNumber, value: buf.subarray(pos, end) });
    pos = end;
  }
  return fields;
}

export function computeExtensionIdFromPublicKeyDer(spkiDer) {
  const hash = crypto.createHash("sha256").update(spkiDer).digest().subarray(0, 16);
  const chars = [];
  const aCode = "a".charCodeAt(0);
  for (const byte of hash) {
    chars.push(String.fromCharCode(aCode + ((byte >> 4) & 0x0f)));
    chars.push(String.fromCharCode(aCode + (byte & 0x0f)));
  }
  return chars.join("");
}

export function createZipBuffer(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const { rel, data } of files) {
    const nameBuf = Buffer.from(String(rel).replace(/\\/g, "/"), "utf8");
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const compressed = zlib.deflateRawSync(raw, { level: 6 });
    const useStore = compressed.length >= raw.length;
    const payload = useStore ? raw : compressed;
    const method = useStore ? 0 : 8;
    const sum = crc32(raw);

    const localHeader = Buffer.concat([
      uint32LE(0x04034b50),
      uint16LE(20),
      uint16LE(0x0800), // UTF-8 filename flag
      uint16LE(method),
      uint16LE(0),
      uint16LE(0x5421), // fixed reproducible DOS date (2022-01-01)
      uint32LE(sum),
      uint32LE(payload.length),
      uint32LE(raw.length),
      uint16LE(nameBuf.length),
      uint16LE(0),
      nameBuf,
    ]);
    localParts.push(localHeader, payload);

    const centralHeader = Buffer.concat([
      uint32LE(0x02014b50),
      uint16LE(20),
      uint16LE(20),
      uint16LE(0x0800),
      uint16LE(method),
      uint16LE(0),
      uint16LE(0x5421),
      uint32LE(sum),
      uint32LE(payload.length),
      uint32LE(raw.length),
      uint16LE(nameBuf.length),
      uint16LE(0),
      uint16LE(0),
      uint16LE(0),
      uint16LE(0),
      uint32LE(0),
      uint32LE(offset),
      nameBuf,
    ]);
    centralParts.push(centralHeader);
    offset += localHeader.length + payload.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.concat([
    uint32LE(0x06054b50),
    uint16LE(0),
    uint16LE(0),
    uint16LE(files.length),
    uint16LE(files.length),
    uint32LE(centralDir.length),
    uint32LE(offset),
    uint16LE(0),
  ]);
  return Buffer.concat([...localParts, centralDir, eocd]);
}

export function collectExtensionFiles(sourceDir = ROOT, relBase = "") {
  const out = [];
  const entries = fs.readdirSync(sourceDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const ent of entries) {
    if (!relBase && EXCLUDED_TOP.has(ent.name)) continue;
    if (ent.name === ".DS_Store" || /\.pem$/i.test(ent.name) || /\.crx$/i.test(ent.name) || /\.zip$/i.test(ent.name) || /\.local\.md$/i.test(ent.name)) {
      continue;
    }
    const abs = path.join(sourceDir, ent.name);
    const rel = relBase ? `${relBase}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push(...collectExtensionFiles(abs, rel));
    else if (ent.isFile()) out.push({ abs, rel });
  }
  return out;
}

export function loadSigningKey({ keyPath = "", ephemeral = false } = {}) {
  const envPem = String(process.env.CRX_PRIVATE_KEY || "").trim();
  if (envPem) {
    const priv = crypto.createPrivateKey(envPem);
    const spkiDer = crypto.createPublicKey(priv).export({ type: "spki", format: "der" });
    return { privateKeyPem: envPem, spkiDer, ephemeral: false };
  }

  const candidate = keyPath || path.join(os.homedir(), ".autobot", "browser-ext-key.pem");
  if (!ephemeral && candidate && fs.existsSync(candidate)) {
    const existing = fs.readFileSync(candidate, "utf8");
    const priv = crypto.createPrivateKey(existing);
    const spkiDer = crypto.createPublicKey(priv).export({ type: "spki", format: "der" });
    return { privateKeyPem: existing, spkiDer, ephemeral: false };
  }

  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { privateKeyPem: privateKey, spkiDer: Buffer.from(publicKey), ephemeral: true };
}

export function verifyCrx3Buffer(crxBuf) {
  const buf = Buffer.from(crxBuf || []);
  if (buf.length < 16) return { ok: false, error: "CRX buffer too small" };
  if (buf.subarray(0, 4).toString("ascii") !== "Cr24") return { ok: false, error: "Bad CRX magic" };
  const version = buf.readUInt32LE(4);
  if (version !== 3) return { ok: false, error: `Expected CRX3 v3, got ${version}` };
  const headerLen = buf.readUInt32LE(8);
  const headerEnd = 12 + headerLen;
  if (headerEnd > buf.length) return { ok: false, error: "Truncated CRX3 header" };

  const headerFields = parseProtoFields(buf.subarray(12, headerEnd));
  const rsaProof = headerFields.find((f) => f.fieldNumber === 2);
  const signedHeaderField = headerFields.find((f) => f.fieldNumber === 10000);
  if (!rsaProof || !signedHeaderField) return { ok: false, error: "Missing CRX3 proof or signed header" };

  const proofFields = parseProtoFields(rsaProof.value);
  const pubKeyField = proofFields.find((f) => f.fieldNumber === 1);
  const sigField = proofFields.find((f) => f.fieldNumber === 2);
  if (!pubKeyField || !sigField) return { ok: false, error: "Missing public key or signature in proof" };

  const signedFields = parseProtoFields(signedHeaderField.value);
  const crxIdField = signedFields.find((f) => f.fieldNumber === 1);
  if (!crxIdField || crxIdField.value.length !== 16) return { ok: false, error: "Invalid CRX3 crx_id" };

  const expectedId = crypto.createHash("sha256").update(pubKeyField.value).digest().subarray(0, 16);
  if (!expectedId.equals(crxIdField.value)) return { ok: false, error: "CRX3 crx_id mismatch" };

  const zipBytes = buf.subarray(headerEnd);
  const signedPayload = Buffer.concat([
    Buffer.from("CRX3 SignedData\x00", "binary"),
    uint32LE(signedHeaderField.value.length),
    signedHeaderField.value,
    zipBytes,
  ]);
  const pubKey = crypto.createPublicKey({ key: pubKeyField.value, format: "der", type: "spki" });
  if (!crypto.verify("sha256", signedPayload, pubKey, sigField.value)) {
    return { ok: false, error: "RSA-SHA256 signature verification failed" };
  }

  return {
    ok: true,
    version: 3,
    extensionId: computeExtensionIdFromPublicKeyDer(pubKeyField.value),
    size: buf.length,
  };
}

export function buildReleaseArtifacts({
  sourceDir = ROOT,
  outDir = path.join(ROOT, "release"),
  keyPath = "",
  ephemeral = false,
  repo = GITHUB_REPO,
} = {}) {
  const manifestRaw = JSON.parse(fs.readFileSync(path.join(sourceDir, "manifest.json"), "utf8"));
  const version = String(manifestRaw.version || "1.0.0").trim();
  const tagName = `v${version}`;
  const files = collectExtensionFiles(sourceDir);

  const keyInfo = loadSigningKey({ keyPath, ephemeral });
  const extensionId = computeExtensionIdFromPublicKeyDer(keyInfo.spkiDer);
  const pubKeyBase64 = Buffer.from(keyInfo.spkiDer).toString("base64");

  const zipFiles = files.map((f) => ({
    rel: f.rel,
    data: fs.readFileSync(f.abs),
  }));
  const zipBuffer = createZipBuffer(zipFiles);

  const crxManifest = {
    ...manifestRaw,
    key: pubKeyBase64,
    update_url: repo === GITHUB_REPO ? UPDATES_XML_URL : `https://github.com/${repo}/releases/latest/download/updates.xml`,
  };
  const crxManifestBuf = Buffer.from(JSON.stringify(crxManifest, null, 2) + "\n", "utf8");
  const crxZipFiles = files.map((f) => ({
    rel: f.rel,
    data: f.rel === "manifest.json" ? crxManifestBuf : fs.readFileSync(f.abs),
  }));
  const crxZipBuffer = createZipBuffer(crxZipFiles);

  const crxId = crypto.createHash("sha256").update(keyInfo.spkiDer).digest().subarray(0, 16);
  const signedDataBytes = encodeBytesField(1, crxId);
  const signedPayload = Buffer.concat([
    Buffer.from("CRX3 SignedData\x00", "binary"),
    uint32LE(signedDataBytes.length),
    signedDataBytes,
    crxZipBuffer,
  ]);
  const signature = crypto.sign("sha256", signedPayload, keyInfo.privateKeyPem);
  const proofBytes = Buffer.concat([
    encodeBytesField(1, keyInfo.spkiDer),
    encodeBytesField(2, signature),
  ]);
  const headerBytes = Buffer.concat([
    encodeBytesField(2, proofBytes),
    encodeBytesField(10000, signedDataBytes),
  ]);
  const crxBuffer = Buffer.concat([
    Buffer.from("Cr24", "ascii"),
    uint32LE(3),
    uint32LE(headerBytes.length),
    headerBytes,
    crxZipBuffer,
  ]);

  const verified = verifyCrx3Buffer(crxBuffer);
  if (!verified.ok) throw new Error(`Self-verification failed: ${verified.error}`);

  fs.mkdirSync(outDir, { recursive: true });
  const zipName = `AkronBrowserBot-${version}.zip`;
  const crxName = `AkronBrowserBot-${version}.crx`;
  const zipOut = path.join(outDir, zipName);
  const crxOut = path.join(outDir, crxName);
  fs.writeFileSync(zipOut, zipBuffer);
  fs.writeFileSync(crxOut, crxBuffer);

  const zipSha = crypto.createHash("sha256").update(zipBuffer).digest("hex");
  const crxSha = crypto.createHash("sha256").update(crxBuffer).digest("hex");
  const crxDownloadUrl = `https://github.com/${repo}/releases/download/${tagName}/${crxName}`;
  const zipDownloadUrl = `https://github.com/${repo}/releases/download/${tagName}/${zipName}`;

  const updatesXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">',
    `  <app appid="${extensionId}">`,
    `    <updatecheck codebase="${crxDownloadUrl}" version="${version}" />`,
    "  </app>",
    "</gupdate>",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "updates.xml"), updatesXml, "utf8");

  const latestJson = {
    name: `Akron Browser Bot ${tagName}`,
    version,
    tagName,
    repo,
    extensionId,
    prerelease: /-/.test(version),
    publishedAt: new Date().toISOString(),
    htmlUrl: `https://github.com/${repo}/releases/tag/${tagName}`,
    zipName,
    zipUrl: zipDownloadUrl,
    crxName,
    crxUrl: crxDownloadUrl,
    updatesXmlUrl: `https://github.com/${repo}/releases/latest/download/updates.xml`,
    sumsUrl: `https://github.com/${repo}/releases/download/${tagName}/SHA256SUMS.txt`,
    sha256: {
      [zipName]: zipSha,
      [crxName]: crxSha,
    },
  };
  fs.writeFileSync(path.join(outDir, "latest.json"), JSON.stringify(latestJson, null, 2) + "\n", "utf8");

  const sumsText = [
    `${zipSha}  ${zipName}`,
    `${crxSha}  ${crxName}`,
    "",
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "SHA256SUMS.txt"), sumsText, "utf8");

  return {
    ok: true,
    version,
    tagName,
    extensionId,
    ephemeralKey: keyInfo.ephemeral,
    outDir,
    files: [zipName, crxName, "updates.xml", "latest.json", "SHA256SUMS.txt"],
    sha256: latestJson.sha256,
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const args = process.argv.slice(2);
  let keyPath = "";
  let outDir = path.join(ROOT, "release");
  let ephemeral = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--key") keyPath = args[++i] || "";
    else if (args[i] === "--out") outDir = args[++i] || outDir;
    else if (args[i] === "--ephemeral-key") ephemeral = true;
  }
  const result = buildReleaseArtifacts({ sourceDir: ROOT, outDir, keyPath, ephemeral });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}
