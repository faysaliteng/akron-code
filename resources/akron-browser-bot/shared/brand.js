// The product's name, maker and logo. They belong to akronlogic.com (see
// LICENSE and TRADEMARK.md) and are sealed: checkBrand() compares the files of
// this copy with the values below and with the logo fingerprints in
// brand-seal.js. A copy whose name or logo was changed takes no tasks.

import { BRAND_SEAL } from "./brand-seal.js";

export const BRAND = Object.freeze({
  name: "Akron Browser Bot",
  shortName: "Akron",
  maker: "akronlogic.com",
});

export const BRAND_BLOCKED_MESSAGE = `This copy of ${BRAND.name} has been changed: its name or logo is not the original from ${BRAND.maker}, so it will not run tasks. Install the original copy again.`;

const LOCALES = Object.freeze(["en", "de", "es", "fr", "ja", "zh_CN"]);
const ICONS = Object.freeze({
  16: "icons/icon16.png",
  32: "icons/icon32.png",
  48: "icons/icon48.png",
  128: "icons/icon128.png",
});
// Pages the user sees: each must carry the product's name in its title and
// name the maker somewhere on the page.
const PAGES = Object.freeze([
  "sidepanel/sidepanel.html",
  "options/options.html",
  "onboarding/onboarding.html",
]);

const sameIcons = (map) =>
  !!map && Object.entries(ICONS).every(([size, file]) => map[size] === file);

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Each check returns the problems it found; a file that cannot be read is a
// problem too, never an exception.
async function manifestProblems(readText) {
  try {
    const manifest = JSON.parse(await readText("manifest.json"));
    const ok =
      manifest.name === "__MSG_appName__" &&
      manifest.action?.default_title === "__MSG_actionTitle__" &&
      sameIcons(manifest.icons) &&
      sameIcons(manifest.action?.default_icon);
    return ok ? [] : ["manifest.json: the name or the icons were changed"];
  } catch (error) {
    return [`manifest.json: cannot be read (${error?.message || error})`];
  }
}

async function localeProblems(readText, locale) {
  const file = `_locales/${locale}/messages.json`;
  try {
    const messages = JSON.parse(await readText(file));
    const ok =
      messages.appName?.message === BRAND.name &&
      String(messages.actionTitle?.message || "").includes(BRAND.name);
    return ok ? [] : [`${file}: the product name was changed`];
  } catch (error) {
    return [`${file}: cannot be read (${error?.message || error})`];
  }
}

async function pageProblems(readText, file) {
  try {
    const html = await readText(file);
    const title = /<title>([^<]*)<\/title>/i.exec(html)?.[1] || "";
    const ok = title.includes(BRAND.name) && html.includes(BRAND.maker);
    return ok ? [] : [`${file}: the product name or its maker was removed`];
  } catch (error) {
    return [`${file}: cannot be read (${error?.message || error})`];
  }
}

async function logoProblems(readBytes, file) {
  try {
    const found = await sha256Hex(await readBytes(file));
    return found === BRAND_SEAL[file] ? [] : [`${file}: the logo was replaced`];
  } catch (error) {
    return [`${file}: cannot be read (${error?.message || error})`];
  }
}

/**
 * Compares this copy's name, maker and logo with the sealed originals.
 * @param {{ readText: (file: string) => Promise<string>, readBytes: (file: string) => Promise<ArrayBuffer | Uint8Array> }} files
 * @returns {Promise<string[]>} what was changed; empty when the copy is intact
 */
export async function checkBrand({ readText, readBytes }) {
  const found = await Promise.all([
    manifestProblems(readText),
    ...LOCALES.map((locale) => localeProblems(readText, locale)),
    ...PAGES.map((file) => pageProblems(readText, file)),
    ...Object.keys(BRAND_SEAL).map((file) => logoProblems(readBytes, file)),
  ]);
  return found.flat();
}
