// GitHub Release auto-update checker and metadata normalizer for Akron Browser Bot.
// Runs identically in MV3 Extension workers/pages (fetch) and Node CLIs.

export const GITHUB_REPO = "faysaliteng/akron-browser-bot";
export const UPDATES_XML_URL = `https://github.com/${GITHUB_REPO}/releases/latest/download/updates.xml`;
export const LATEST_JSON_URL = `https://github.com/${GITHUB_REPO}/releases/latest/download/latest.json`;
export const RELEASES_API_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases`;

/**
 * Parse a semantic version string such as "v1.6.8" or "1.6.8-beta.1".
 * @param {string} raw
 */
export function parseSemver(raw) {
  const s = String(raw || "").trim().replace(/^v/i, "");
  const [corePart, ...preParts] = s.split("-");
  const nums = corePart.split(".").map((n) => parseInt(n, 10));
  if (!nums.length || Number.isNaN(nums[0])) return null;
  const pre = preParts.join("-").trim();
  return {
    major: nums[0] || 0,
    minor: nums[1] || 0,
    patch: nums[2] || 0,
    pre: pre ? pre.split(".") : [],
  };
}

/**
 * Compare two semantic versions. Returns 1 if a > b, -1 if a < b, 0 if equal.
 * @param {string} a
 * @param {string} b
 */
export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa && !pb) return String(a || "").localeCompare(String(b || ""));
  if (!pa) return -1;
  if (!pb) return 1;
  for (const k of ["major", "minor", "patch"]) {
    if (pa[k] !== pb[k]) return pa[k] > pb[k] ? 1 : -1;
  }
  if (!pa.pre.length && !pb.pre.length) return 0;
  if (!pa.pre.length) return 1;
  if (!pb.pre.length) return -1;
  const len = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < len; i++) {
    const ai = pa.pre[i];
    const bi = pb.pre[i];
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;
    const an = /^\d+$/.test(ai) ? Number(ai) : null;
    const bn = /^\d+$/.test(bi) ? Number(bi) : null;
    if (an !== null && bn !== null) {
      if (an !== bn) return an > bn ? 1 : -1;
    } else if (an !== null) {
      return -1;
    } else if (bn !== null) {
      return 1;
    } else if (ai !== bi) {
      return ai > bi ? 1 : -1;
    }
  }
  return 0;
}

/**
 * Normalize either a `latest.json` manifest or a GitHub REST release payload.
 * @param {object} raw
 * @param {string} [repo]
 */
export function normalizeReleasePayload(raw, repo = GITHUB_REPO) {
  if (!raw || typeof raw !== "object") return null;

  const isLatestJson =
    typeof raw.version === "string" &&
    !Array.isArray(raw.assets) &&
    (raw.zipName || raw.zipUrl || raw.crxUrl || raw.assetsMap);

  const tagName = String(raw.tagName || raw.tag_name || (raw.version ? `v${String(raw.version).replace(/^v/i, "")}` : "")).trim();
  const version = String(raw.version || tagName).trim().replace(/^v/i, "");
  if (!version) return null;

  if (isLatestJson || (raw.version && raw.zipUrl && !Array.isArray(raw.assets))) {
    const zipName = raw.zipName || `AkronBrowserBot-${version}.zip`;
    const crxName = raw.crxName || `AkronBrowserBot-${version}.crx`;
    const baseDl = `https://github.com/${repo}/releases/download/${tagName || `v${version}`}`;
    return {
      version,
      tagName: tagName || `v${version}`,
      htmlUrl: raw.htmlUrl || `https://github.com/${repo}/releases/tag/${tagName || `v${version}`}`,
      publishedAt: raw.publishedAt || "",
      prerelease: !!raw.prerelease,
      notes: String(raw.notes || "").trim(),
      extensionId: String(raw.extensionId || "").trim(),
      zipName,
      zipUrl: raw.zipUrl || `${baseDl}/${zipName}`,
      zipApiUrl: raw.zipApiUrl || "",
      crxName,
      crxUrl: raw.crxUrl || `${baseDl}/${crxName}`,
      crxApiUrl: raw.crxApiUrl || "",
      updatesXmlUrl: raw.updatesXmlUrl || `https://github.com/${repo}/releases/latest/download/updates.xml`,
      sumsUrl: raw.sumsUrl || `${baseDl}/SHA256SUMS.txt`,
      sha256: raw.sha256 && typeof raw.sha256 === "object" ? { ...raw.sha256 } : {},
    };
  }

  const assets = Array.isArray(raw.assets) ? raw.assets : [];
  const findAsset = (pred) => assets.find((a) => a && typeof a.name === "string" && pred(a.name));
  const zipAsset = findAsset((n) => /^AkronBrowserBot-.*\.zip$/i.test(n)) || findAsset((n) => /\.zip$/i.test(n));
  const crxAsset = findAsset((n) => /^AkronBrowserBot-.*\.crx$/i.test(n)) || findAsset((n) => /\.crx$/i.test(n));
  const sumsAsset = findAsset((n) => /^SHA256SUMS\.txt$/i.test(n));
  const xmlAsset = findAsset((n) => /^updates\.xml$/i.test(n));
  const latestJsonAsset = findAsset((n) => /^latest\.json$/i.test(n));

  return {
    version,
    tagName: tagName || `v${version}`,
    htmlUrl: raw.html_url || `https://github.com/${repo}/releases/tag/${tagName || `v${version}`}`,
    publishedAt: raw.published_at || "",
    prerelease: !!raw.prerelease,
    notes: String(raw.body || "").trim(),
    extensionId: "",
    zipName: zipAsset?.name || `AkronBrowserBot-${version}.zip`,
    zipUrl: zipAsset?.browser_download_url || "",
    zipApiUrl: zipAsset?.url || "",
    crxName: crxAsset?.name || `AkronBrowserBot-${version}.crx`,
    crxUrl: crxAsset?.browser_download_url || "",
    crxApiUrl: crxAsset?.url || "",
    updatesXmlUrl: xmlAsset?.browser_download_url || `https://github.com/${repo}/releases/latest/download/updates.xml`,
    sumsUrl: sumsAsset?.browser_download_url || "",
    sumsApiUrl: sumsAsset?.url || "",
    latestJsonApiUrl: latestJsonAsset?.url || "",
    sha256: {},
  };
}

/**
 * Parse SHA256SUMS.txt contents into a `{ filename: hex }` map.
 * @param {string} text
 */
export function parseSha256Sums(text) {
  const out = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (m) out[m[2].trim()] = m[1].toLowerCase();
  }
  return out;
}

/**
 * Query GitHub (or an explicit custom baseUrl for testing) for newer extension releases.
 */
export async function checkForExtensionUpdate({
  currentVersion = "0.0.0",
  repo = GITHUB_REPO,
  channel = "stable",
  token = "",
  baseUrl = "",
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== "function") {
    return {
      ok: false,
      currentVersion,
      updateAvailable: false,
      error: "fetch is not available in this runtime.",
    };
  }

  const cleanToken = String(token || "").trim();
  const cleanChannel = channel === "prerelease" ? "prerelease" : "stable";
  const checkedAt = Date.now();
  const cleanBase = String(baseUrl || "").trim().replace(/\/+$/, "");

  // 1. Custom baseUrl mirror (used by self-hosted mirrors and unit/e2e tests).
  if (cleanBase) {
    try {
      const headers = cleanToken ? { Authorization: `Bearer ${cleanToken}` } : {};
      const res = await fetchImpl(`${cleanBase}/latest.json`, { headers });
      if (!res.ok) {
        return {
          ok: false,
          status: res.status,
          currentVersion,
          updateAvailable: false,
          checkedAt,
          error: `Update check failed (HTTP ${res.status}).`,
        };
      }
      const raw = await res.json();
      const release = normalizeReleasePayload(raw, repo);
      if (!release) {
        return { ok: false, currentVersion, updateAvailable: false, checkedAt, error: "Invalid latest.json manifest." };
      }
      if (cleanBase) {
        release.zipUrl = `${cleanBase}/${release.zipName}`;
        release.crxUrl = `${cleanBase}/${release.crxName}`;
        release.sumsUrl = `${cleanBase}/SHA256SUMS.txt`;
      }
      const updateAvailable = compareSemver(release.version, currentVersion) > 0;
      return {
        ok: true,
        via: "mirror-latest-json",
        currentVersion,
        latestVersion: release.version,
        updateAvailable,
        release,
        checkedAt,
      };
    } catch (e) {
      return { ok: false, currentVersion, updateAvailable: false, checkedAt, error: String(e?.message || e) };
    }
  }

  // 2. Public zero-rate-limit latest.json when stable and unauthenticated.
  let lastStatus = 0;
  if (cleanChannel === "stable" && !cleanToken) {
    try {
      const latestUrl = `https://github.com/${repo}/releases/latest/download/latest.json`;
      const res = await fetchImpl(latestUrl, {
        headers: { Accept: "application/json", "Cache-Control": "no-cache" },
      });
      lastStatus = res.status;
      if (res.ok) {
        const raw = await res.json();
        const release = normalizeReleasePayload(raw, repo);
        if (release) {
          return {
            ok: true,
            via: "github-latest-json",
            currentVersion,
            latestVersion: release.version,
            updateAvailable: compareSemver(release.version, currentVersion) > 0,
            release,
            checkedAt,
          };
        }
      }
    } catch {
      // Fall through to GitHub REST API.
    }
  }

  // 3. GitHub REST API (supports prereleases, private repos with token, and fallback).
  const apiUrl =
    cleanChannel === "stable"
      ? `https://api.github.com/repos/${repo}/releases/latest`
      : `https://api.github.com/repos/${repo}/releases?per_page=10`;
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (cleanToken) headers.Authorization = `Bearer ${cleanToken}`;

  try {
    const res = await fetchImpl(apiUrl, { headers });
    lastStatus = res.status;
    if (!res.ok) {
      if (res.status === 404 && !cleanToken) {
        return {
          ok: false,
          status: 404,
          privateOrMissing: true,
          currentVersion,
          updateAvailable: false,
          checkedAt,
          error:
            "No public release found on GitHub (if repository is private, add a GitHub token in Settings → Updates or make the repository public).",
        };
      }
      return {
        ok: false,
        status: res.status,
        currentVersion,
        updateAvailable: false,
        checkedAt,
        error: `GitHub API returned HTTP ${res.status}.`,
      };
    }

    const data = await res.json();
    const candidates = Array.isArray(data) ? data : [data];
    const usable = candidates
      .filter((r) => r && !r.draft && (cleanChannel === "prerelease" || !r.prerelease))
      .map((r) => normalizeReleasePayload(r, repo))
      .filter(Boolean)
      .sort((a, b) => compareSemver(b.version, a.version));

    if (!usable.length) {
      return {
        ok: false,
        status: 404,
        currentVersion,
        updateAvailable: false,
        checkedAt,
        error: "No matching GitHub releases found for this channel.",
      };
    }

    const release = usable[0];
    return {
      ok: true,
      via: "github-api",
      currentVersion,
      latestVersion: release.version,
      updateAvailable: compareSemver(release.version, currentVersion) > 0,
      release,
      checkedAt,
    };
  } catch (e) {
    return {
      ok: false,
      status: lastStatus || 0,
      currentVersion,
      updateAvailable: false,
      checkedAt,
      error: String(e?.message || e),
    };
  }
}
