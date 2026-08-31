/**
 * Renders a client-facing HTML document in docs/ops/client-requests/ to a PDF
 * beside it, so the thing you forward is regenerated from source rather than
 * hand-exported from a browser.
 *
 * Usage:  node scripts/build-client-doc.mjs azalea-cloudflare-request
 *
 * Three things this handles that a manual "Print to PDF" does not:
 *
 *   1. Fonts are inlined from fonts-inline.css as base64 woff2 rather than
 *      linked from Google Fonts. Headless Chrome would not fetch them in
 *      time, and the document silently fell back to Times New Roman -- which
 *      still *looks* like a document, so the failure is easy to ship.
 *   2. The wrapper is stamped data-theme="light". Headless Chrome here
 *      reports a dark prefers-color-scheme, and the source is theme-aware, so
 *      without this the PDF renders dark-on-dark.
 *   3. The source file is an Artifact body (no <html>/<head>/<body>), so it is
 *      split at </style> and reassembled into a real document. Getting this
 *      wrong puts the stylesheet somewhere it does not apply, and the output
 *      is an unstyled five-page wall of Times -- the first attempt did exactly
 *      that and looked plausible enough to nearly pass.
 *
 * Chrome is located rather than assumed; pass CHROME=/path/to/chrome to
 * override.
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const DOC_DIR = resolve("docs/ops/client-requests");

const CHROME_CANDIDATES = [
  process.env.CHROME,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);

function findChrome() {
  const found = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      `No Chrome or Edge found. Tried:\n  ${CHROME_CANDIDATES.join("\n  ")}\n` +
        "Set CHROME=/path/to/chrome to point at one.",
    );
  }
  return found;
}

const name = process.argv[2];
if (!name) {
  console.error("Usage: node scripts/build-client-doc.mjs <document-name>");
  console.error("  e.g. node scripts/build-client-doc.mjs azalea-cloudflare-request");
  process.exit(1);
}

const srcPath = join(DOC_DIR, `${name}.html`);
if (!existsSync(srcPath)) throw new Error(`No such document: ${srcPath}`);

const src = readFileSync(srcPath, "utf8");
const fontsPath = join(DOC_DIR, "fonts-inline.css");
const fonts = existsSync(fontsPath) ? readFileSync(fontsPath, "utf8") : "";
if (!fonts) {
  console.warn("! fonts-inline.css missing — the PDF will fall back to system fonts.");
}

// Split at the end of the last style block: everything up to there belongs in
// <head>, the rest is the document body.
const cut = src.lastIndexOf("</style>");
if (cut < 0) throw new Error("Expected a <style> block in the source document.");
let head = src.slice(0, cut + "</style>".length);
const body = src.slice(cut + "</style>".length);

// Replace the network font link with the embedded faces.
head = head
  .replace(/<link rel="preconnect"[^>]*>\s*/g, "")
  .replace(
    /<link rel="stylesheet" href="https:\/\/fonts\.googleapis[^>]*>/,
    fonts ? `<style>${fonts}</style>` : "",
  );

const html = `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${head}
</head>
<body>
${body}
</body>
</html>`;

const work = mkdtempSync(join(tmpdir(), "clientdoc-"));
const wrapPath = join(work, "wrap.html");
writeFileSync(wrapPath, html);

const outPath = join(DOC_DIR, `${name}.pdf`);
if (existsSync(outPath)) unlinkSync(outPath);

const chrome = findChrome();
try {
  execFileSync(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--no-pdf-header-footer",
      // Generous, because the document embeds ~600KB of fonts that must be
      // parsed before first paint.
      "--virtual-time-budget=30000",
      "--run-all-compositor-stages-before-draw",
      `--user-data-dir=${join(work, "profile")}`,
      `--print-to-pdf=${outPath}`,
      `file:///${wrapPath.replace(/\\/g, "/")}`,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (!existsSync(outPath)) throw new Error("Chrome reported success but wrote no PDF.");

// Page count is the cheap smoke test: a one-page result almost always means
// the stylesheet did not apply and everything collapsed.
const raw = readFileSync(outPath).toString("latin1");
const pages = (raw.match(/\/Type\s*\/Page[^s]/g) || []).length;
const kb = Math.round(readFileSync(outPath).length / 1024);
console.log(`Wrote ${outPath}`);
console.log(`  ${pages} page${pages === 1 ? "" : "s"}, ${kb} KB`);
if (pages <= 1) {
  console.warn("! Only one page — check that the stylesheet applied.");
}
