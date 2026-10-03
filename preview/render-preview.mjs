// Local preview of the certificate layout.
//   node preview/render-preview.mjs [fixture.txt] [outDir]
// Compiles the edge function's lib/ to JS, swaps pdf-lib for a browser SVG
// stand-in (mock-pdf-lib.js), renders in headless Chromium and writes one PNG
// per page. Fonts and logo are the same files the deployed function uses.

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.resolve(process.argv[2] ?? path.join(root, "tests/fixtures/narre_warren_dental_2026-09-14.txt"));
const outDir = path.resolve(process.argv[3] ?? path.join(root, "preview/out"));
const build = path.join(root, "preview/.build");

rmSync(build, { recursive: true, force: true });
mkdirSync(build, { recursive: true });
mkdirSync(outDir, { recursive: true });

const lib = path.join(root, "supabase/functions/patlink-certificate/lib");
writeFileSync(
  path.join(build, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      target: "es2022",
      module: "esnext",
      moduleResolution: "bundler",
      allowImportingTsExtensions: true,
      rewriteRelativeImportExtensions: true,
      noCheck: true,
      outDir: build,
      rootDir: lib,
      types: [],
      skipLibCheck: true,
    },
    files: ["parser.ts", "summary.ts", "clients.ts", "render.ts", "types.ts"].map((f) => path.join(lib, f)),
  }),
);
execFileSync("/opt/node22/lib/node_modules/typescript/bin/tsc", ["-p", path.join(build, "tsconfig.json")], {
  stdio: "inherit",
});
cpSync(path.join(root, "preview/mock-pdf-lib.js"), path.join(build, "mock-pdf-lib.js"));
cpSync(path.join(root, "assets"), path.join(build, "assets"), { recursive: true });
writeFileSync(path.join(build, "fixture.txt"), readFileSync(fixture));
writeFileSync(path.join(build, "fontkit.js"), "export default {};");

writeFileSync(
  path.join(build, "index.html"),
  `<!doctype html><html><head><meta charset="utf-8">
<style>
@font-face{font-family:'Liberation Sans';font-weight:400;src:url(assets/fonts/LiberationSans-Regular.ttf)}
@font-face{font-family:'Liberation Sans';font-weight:700;src:url(assets/fonts/LiberationSans-Bold.ttf)}
body{margin:0;background:#888}
</style>
<script type="importmap">{"imports":{"npm:pdf-lib@1.17.1":"./mock-pdf-lib.js","npm:@pdf-lib/fontkit@1.1.1":"./fontkit.js"}}</script>
</head><body><span style="font-family:'Liberation Sans'">.</span><b style="font-family:'Liberation Sans'">.</b>
<script type="module">
import { parsePatlinkText } from "./parser.js";
import { summarise } from "./summary.js";
import { lookupClient } from "./clients.js";
import { createDocument, renderCertificate } from "./render.js";
await document.fonts.ready;
await document.fonts.load("400 10px 'Liberation Sans'");
await document.fonts.load("700 10px 'Liberation Sans'");
const text = await (await fetch("fixture.txt")).text();
const report = parsePatlinkText(text.split("\\n"));
const clientsMd = "| Site | Company | Contact | Email | Address |\\n|---|---|---|---|---|\\n| Narre Warren Dental | Narre Warren Dental Pty Ltd | Practice Manager | admin@example.com.au | Suite 3, 1 Example St, Narre Warren VIC 3805 |";
const client = lookupClient(clientsMd, report.site);
const summary = summarise(report);
const { doc, fonts } = await createDocument({ reg: "assets/fonts/LiberationSans-Regular.ttf", bold: "assets/fonts/LiberationSans-Bold.ttf" });
const pages = await renderCertificate(doc, fonts, {
  report, summary, client,
  business: { businessName: "RX Test N Tag", tagline: "Tested. Tagged. Trusted.", technician: "Ric Example", abn: "12 345 678 901",
    phone: "0400 000 000", email: "info@rxtnt.com.au", website: "rxtnt.com.au", address: "Narre Warren VIC", standard: "AS/NZS 3760" },
  certificateNo: "RXT-20261003-101500", issuedAt: "03/10/2026 10:15", reviewNotes: [], sourceFilename: "narre_warren_dental_clinic.pdf",
}, "assets/rxtnt-logo.png");
window.__pages = pages;
</script></body></html>`,
);

// The page fetches the logo and fonts, so serve the build dir over HTTP.
const types = { ".html": "text/html", ".js": "text/javascript", ".png": "image/png", ".ttf": "font/ttf", ".txt": "text/plain" };
const server = http.createServer((req, res) => {
  const p = path.join(build, decodeURIComponent(new URL(req.url, "http://x").pathname));
  try {
    const body = readFileSync(p);
    res.writeHead(200, { "Content-Type": types[path.extname(p)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: 595, height: 842 } });
page.on("pageerror", (e) => console.error("page error:", e));
page.on("console", (m) => m.type() === "error" && console.error("console:", m.text()));
await page.goto(`http://127.0.0.1:${port}/index.html`);
await page.waitForFunction(() => window.__pages, null, { timeout: 30000 });
const svgs = await page.evaluate(() => window.__pages);
for (const [i, svg] of svgs.entries()) {
  // Same document, so the @font-face fonts already loaded stay in effect.
  await page.evaluate((s) => {
    document.body.style.background = "#fff";
    document.body.innerHTML = s;
  }, svg);
  await page.waitForTimeout(200);
  const file = path.join(outDir, `page-${i + 1}.png`);
  await page.screenshot({ path: file, clip: { x: 0, y: 0, width: 595, height: 842 } });
  console.log(file);
}
await browser.close();
server.close();
