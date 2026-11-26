// Writes shared/brand-seal.js: the SHA-256 fingerprint of every logo file.
// Run it (npm run brand:seal) after the owner changes the logo; the extension
// refuses to work when a logo file does not match its fingerprint.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOGO_FILES = ["icons/icon16.png", "icons/icon32.png", "icons/icon48.png", "icons/icon128.png", "icons/logo.svg"];

const fingerprint = (file) => createHash("sha256").update(fs.readFileSync(path.join(ROOT, file))).digest("hex");

const lines = LOGO_FILES.map((file) => `  "${file}": "${fingerprint(file)}",`);
const source = [
  '// Written by "npm run brand:seal". Do not edit by hand.',
  "// SHA-256 fingerprints of the logo files (see shared/brand.js).",
  "export const BRAND_SEAL = Object.freeze({",
  ...lines,
  "});",
  "",
].join("\n");

fs.writeFileSync(path.join(ROOT, "shared/brand-seal.js"), source);
process.stdout.write(`Sealed ${LOGO_FILES.length} logo files in shared/brand-seal.js\n`);
