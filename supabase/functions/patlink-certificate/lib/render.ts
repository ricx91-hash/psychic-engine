// Branded Certificate of Compliance + itemised Test Report (pdf-lib).
// Every test value is drawn from the exact source string. The renderer never
// formats, rounds or re-words a value. A character the font can't draw is
// shown as [U+XXXX], and index.ts has already marked the report
// REVIEW REQUIRED if that happens.

import { PDFDocument, PDFFont, PDFImage, PDFPage, rgb, StandardFonts } from "npm:pdf-lib@1.17.1";
import fontkit from "npm:@pdf-lib/fontkit@1.1.1";
import type { BusinessConfig } from "./config.ts";
import { displayStatus } from "./summary.ts";
import type { ClientLookup, DisplayStatus, Item, KV, ParsedReport, Summary } from "./types.ts";

type RGB = ReturnType<typeof rgb>;
const hex = (h: string): RGB =>
  rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);

const C = {
  navy: hex("#0B1F3A"),
  red: hex("#8B1A1A"),
  gold: hex("#C9A227"),
  ink: hex("#1A1A1A"),
  muted: hex("#5A6270"),
  line: hex("#D5D9E0"),
  panel: hex("#F3F5F8"),
  white: rgb(1, 1, 1),
  pass: hex("#1E7B34"),
  fail: hex("#B3261E"),
  noResult: hex("#6B6B6B"),
  unverified: hex("#C45A00"),
};

const STATUS_COLOUR: Record<DisplayStatus, RGB> = {
  PASS: C.pass,
  FAIL: C.fail,
  "NO RESULT": C.noResult,
  UNVERIFIED: C.unverified,
};
const OVERALL_COLOUR: Record<Summary["overall"], RGB> = {
  COMPLIANT: C.pass,
  "FAILURES PRESENT": C.fail,
  INCOMPLETE: C.noResult,
  "REVIEW REQUIRED": C.unverified,
};

const A4: [number, number] = [595.28, 841.89];
const M = 40; // page margin
const W = A4[0] - 2 * M;
const BOTTOM = 56; // keep clear for footer

export interface Fonts {
  reg: PDFFont;
  bold: PDFFont;
  unicode: boolean;
}

export interface RenderInput {
  report: ParsedReport;
  summary: Summary;
  client: ClientLookup;
  business: BusinessConfig;
  certificateNo: string;
  issuedAt: string;
  /** Pipeline-level issues (client lookup, config, unsupported chars). */
  reviewNotes: string[];
  sourceFilename: string;
}

const fontCache = new Map<string, Uint8Array>();

async function fetchFont(url: string): Promise<Uint8Array> {
  const hit = fontCache.get(url);
  if (hit) return hit;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  fontCache.set(url, bytes);
  return bytes;
}

/** Load a Unicode TTF if reachable, else fall back to Helvetica. */
export async function loadFonts(doc: PDFDocument, regUrl: string, boldUrl: string): Promise<Fonts> {
  try {
    const [r, b] = await Promise.all([fetchFont(regUrl), fetchFont(boldUrl)]);
    doc.registerFontkit(fontkit);
    return { reg: await doc.embedFont(r, { subset: true }), bold: await doc.embedFont(b, { subset: true }), unicode: true };
  } catch (e) {
    console.warn("Unicode font unavailable, using Helvetica:", e);
    return {
      reg: await doc.embedFont(StandardFonts.Helvetica),
      bold: await doc.embedFont(StandardFonts.HelveticaBold),
      unicode: false,
    };
  }
}

/** Every string from the source PDF that will be drawn. */
export function sourceStrings(report: ParsedReport): string[] {
  const out: string[] = [
    report.site ?? "",
    report.instrumentModel ?? "",
    ...report.instrumentSerials,
    ...report.issues,
    ...report.groups.map((g) => `${g.path.join("/")} ${g.comment ?? ""}`),
  ];
  for (const it of report.items) {
    out.push(it.path.join("/"), it.name ?? "", ...it.issues);
    for (const f of it.fields) out.push(f.key, f.value);
    for (const t of it.tests) {
      out.push(t.name, t.timestamp, t.instrument ?? "", ...t.issues);
      for (const kv of [...t.info, ...t.results, ...t.parameters]) out.push(kv.key, kv.value);
    }
  }
  return out;
}

export function unsupportedChars(strings: string[], font: PDFFont): string[] {
  const set = new Set(font.getCharacterSet());
  const bad = new Set<string>();
  for (const s of strings) {
    for (const ch of s) {
      const cp = ch.codePointAt(0)!;
      if (cp >= 32 && !set.has(cp)) bad.add(ch);
    }
  }
  return [...bad];
}

class Layout {
  doc: PDFDocument;
  f: Fonts;
  charset: Set<number>;
  page!: PDFPage;
  y = 0;
  pages: PDFPage[] = [];
  logo: PDFImage | null;
  business: BusinessConfig;

  constructor(doc: PDFDocument, f: Fonts, logo: PDFImage | null, business: BusinessConfig) {
    this.doc = doc;
    this.f = f;
    this.charset = new Set(f.reg.getCharacterSet());
    this.logo = logo;
    this.business = business;
  }

  /** Make a string drawable without altering any supported character. */
  s(text: string): string {
    let out = "";
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      if (cp < 32) out += " ";
      else if (this.charset.has(cp)) out += ch;
      else out += `[U+${cp.toString(16).toUpperCase().padStart(4, "0")}]`;
    }
    return out;
  }

  width(text: string, size: number, bold = false): number {
    return (bold ? this.f.bold : this.f.reg).widthOfTextAtSize(this.s(text), size);
  }

  wrap(text: string, size: number, maxWidth: number, bold = false): string[] {
    const lines: string[] = [];
    for (const para of this.s(text).split("\n")) {
      let cur = "";
      for (const word of para.split(" ")) {
        const trial = cur ? `${cur} ${word}` : word;
        if (this.width(trial, size, bold) <= maxWidth) {
          cur = trial;
          continue;
        }
        if (cur) lines.push(cur);
        // Hard-break a single word longer than the line.
        let w = word;
        while (this.width(w, size, bold) > maxWidth && w.length > 1) {
          let n = w.length - 1;
          while (n > 1 && this.width(w.slice(0, n), size, bold) > maxWidth) n--;
          lines.push(w.slice(0, n));
          w = w.slice(n);
        }
        cur = w;
      }
      lines.push(cur);
    }
    return lines;
  }

  draw(text: string, x: number, y: number, size: number, opts: { bold?: boolean; color?: RGB } = {}) {
    this.page.drawText(this.s(text), {
      x,
      y,
      size,
      font: opts.bold ? this.f.bold : this.f.reg,
      color: opts.color ?? C.ink,
    });
  }

  /** Wrapped paragraph at the cursor. */
  para(text: string, opts: { x?: number; width?: number; size?: number; bold?: boolean; color?: RGB; gap?: number } = {}) {
    const size = opts.size ?? 9.5;
    const lh = size * 1.35;
    const x = opts.x ?? M;
    for (const l of this.wrap(text, size, opts.width ?? W - (x - M), opts.bold)) {
      this.ensure(lh);
      this.draw(l, x, this.y - size, size, opts);
      this.y -= lh;
    }
    this.y -= opts.gap ?? 0;
  }

  ensure(h: number) {
    if (this.y - h < BOTTOM) this.reportPage();
  }

  crest(x: number, y: number, scale: number) {
    if (this.logo) {
      const d = this.logo.scale(1);
      const h = 70 * scale;
      this.page.drawImage(this.logo, { x, y: y - h, width: (d.width / d.height) * h, height: h });
      return;
    }
    // Vector shield crest: navy shield, gold rim, gold bolt, "RX" mark.
    const shield = "M30 0 L60 8 L60 34 C60 52 46 64 30 70 C14 64 0 52 0 34 L0 8 Z";
    this.page.drawSvgPath(shield, { x, y, scale, color: C.navy, borderColor: C.gold, borderWidth: 2.5 });
    const bolt = "M36 10 L20 40 L30 40 L24 62 L42 30 L32 30 L40 10 Z";
    this.page.drawSvgPath(bolt, { x, y, scale, color: C.gold });
    const size = 17 * scale;
    const tw = this.f.bold.widthOfTextAtSize("RX", size);
    this.page.drawText("RX", { x: x + 30 * scale - tw / 2, y: y - 40 * scale, size, font: this.f.bold, color: C.white });
  }

  certificatePage() {
    this.page = this.doc.addPage(A4);
    this.pages.push(this.page);
    const top = A4[1];
    this.page.drawRectangle({ x: 0, y: top - 100, width: A4[0], height: 100, color: C.navy });
    this.page.drawRectangle({ x: 0, y: top - 104, width: A4[0], height: 4, color: C.gold });
    this.crest(M, top - 14, 1.05);
    this.draw(this.business.businessName.toUpperCase(), M + 80, top - 46, 22, { bold: true, color: C.white });
    this.draw("Electrical Test & Tag Compliance  ·  South East Melbourne", M + 80, top - 64, 10, { color: C.white });
    this.draw(this.business.tagline, M + 80, top - 82, 11, { bold: true, color: C.gold });
    this.y = top - 124;
  }

  reportPage() {
    this.page = this.doc.addPage(A4);
    this.pages.push(this.page);
    const top = A4[1];
    this.page.drawRectangle({ x: 0, y: top - 50, width: A4[0], height: 50, color: C.navy });
    this.page.drawRectangle({ x: 0, y: top - 53, width: A4[0], height: 3, color: C.gold });
    this.crest(M, top - 6, 0.55);
    this.draw(`${this.business.businessName.toUpperCase()}  ·  TEST REPORT`, M + 44, top - 30, 13, { bold: true, color: C.white });
    const tl = this.business.tagline;
    this.draw(tl, A4[0] - M - this.width(tl, 9, true), top - 30, 9, { bold: true, color: C.gold });
    this.y = top - 72;
  }

  chip(label: string, xRight: number, yTop: number, color: RGB, size = 8.5): number {
    const w = this.width(label, size, true) + 12;
    this.page.drawRectangle({ x: xRight - w, y: yTop - size - 7, width: w, height: size + 7, color });
    this.draw(label, xRight - w + 6, yTop - size - 2.5, size, { bold: true, color: C.white });
    return w;
  }

  heading(text: string, color = C.navy) {
    this.ensure(28);
    this.y -= 6;
    this.draw(text, M, this.y - 12, 12, { bold: true, color });
    this.y -= 16;
    this.page.drawLine({ start: { x: M, y: this.y }, end: { x: M + W, y: this.y }, thickness: 1.2, color: C.gold });
    this.y -= 8;
  }

  /** Two-column label/value rows inside a panel. */
  panel(title: string, rows: [string, string, RGB?][], x = M, width = W) {
    const labelW = width < W ? 84 : 108;
    const size = 9.5;
    const lh = size * 1.35;
    const wrapped = rows.map(([l, v, c]) => ({ l, lines: this.wrap(v || "—", size, width - labelW - 16), c }));
    const h = 24 + wrapped.reduce((a, r) => a + r.lines.length * lh + 3, 0) + 6;
    const top = this.y;
    this.page.drawRectangle({ x, y: top - h, width, height: h, color: C.panel, borderColor: C.line, borderWidth: 0.8 });
    this.page.drawRectangle({ x, y: top - 3, width, height: 3, color: C.navy });
    this.draw(title.toUpperCase(), x + 8, top - 17, 9, { bold: true, color: C.navy });
    let y = top - 26;
    for (const r of wrapped) {
      this.draw(r.l, x + 8, y - size, size, { color: C.muted });
      for (const line of r.lines) {
        this.draw(line, x + 8 + labelW, y - size, size, { bold: !!r.c, color: r.c ?? C.ink });
        y -= lh;
      }
      y -= 3;
    }
    return top - h;
  }

  footers(certNo: string) {
    const n = this.pages.length;
    this.pages.forEach((p, i) => {
      p.drawLine({ start: { x: M, y: 40 }, end: { x: M + W, y: 40 }, thickness: 0.6, color: C.line });
      const left = `Certificate ${certNo}  ·  ${this.business.businessName}  ·  ${this.business.standard}`;
      p.drawText(this.s(left), { x: M, y: 28, size: 7.5, font: this.f.reg, color: C.muted });
      const right = `Page ${i + 1} of ${n}`;
      p.drawText(right, {
        x: M + W - this.f.reg.widthOfTextAtSize(right, 7.5),
        y: 28,
        size: 7.5,
        font: this.f.reg,
        color: C.muted,
      });
    });
  }
}

const kvText = (kvs: KV[]) => kvs.map((k) => `${k.key}: ${k.value}`).join("   |   ");

function drawCertificate(L: Layout, inp: RenderInput) {
  const { report, summary, client, business } = inp;
  L.certificatePage();

  const title = "CERTIFICATE OF COMPLIANCE";
  L.draw(title, (A4[0] - L.width(title, 22, true)) / 2, L.y - 22, 22, { bold: true, color: C.navy });
  L.y -= 34;
  const sub = `Inspection and testing of in-service electrical equipment in accordance with ${business.standard}`;
  L.draw(sub, (A4[0] - L.width(sub, 9.5)) / 2, L.y - 10, 9.5, { color: C.muted });
  L.y -= 22;
  const meta = `Certificate No. ${inp.certificateNo}     Generated ${inp.issuedAt}`;
  L.draw(meta, (A4[0] - L.width(meta, 8.5)) / 2, L.y - 9, 8.5, { color: C.muted });
  L.y -= 22;

  if (summary.overall === "REVIEW REQUIRED") {
    const msg = "DRAFT: UNVERIFIED DATA. DO NOT ISSUE TO CLIENT UNTIL CHECKED AGAINST THE SOURCE PDF.";
    L.page.drawRectangle({ x: M, y: L.y - 22, width: W, height: 22, color: C.unverified });
    L.draw(msg, M + (W - L.width(msg, 9, true)) / 2, L.y - 15, 9, { bold: true, color: C.white });
    L.y -= 32;
  }

  const c = client.client;
  const notFound = "NOT FOUND: check Clients.md";
  const half = (W - 12) / 2;
  const top = L.y;
  const leftBottom = L.panel(
    "Client & site",
    [
      ["Client", c?.company || notFound, c?.company ? undefined : C.unverified],
      ["Contact", c?.contact ?? ""],
      ["Email", c?.email ?? ""],
      ["Site (PATLink)", report.site ?? "NOT FOUND IN PDF", report.site ? undefined : C.unverified],
      ["Site address", c?.address || notFound, c?.address ? undefined : C.unverified],
    ],
    M,
    half,
  );
  L.y = top;
  const rightBottom = L.panel(
    "Testing",
    [
      ["Test date(s)", summary.firstTest === summary.lastTest ? summary.firstTest ?? "" : `${summary.firstTest} to ${summary.lastTest}`],
      ["Standard", business.standard],
      ["Instrument", report.instrumentModel ?? "Not stated in source PDF"],
      ["Instrument S/N", report.instrumentSerials.join(", ") || "Not stated in source PDF"],
      ["Technician", business.technician || "NOT SET", business.technician ? undefined : C.unverified],
    ],
    M + half + 12,
    half,
  );
  L.y = Math.min(leftBottom, rightBottom) - 14;

  // Overall result
  const oc = OVERALL_COLOUR[summary.overall];
  const reasonLines = L.wrap(summary.overallReason, 9.5, W - 24);
  const boxH = 44 + reasonLines.length * 13 + 30;
  L.page.drawRectangle({ x: M, y: L.y - boxH, width: W, height: boxH, borderColor: oc, borderWidth: 2, color: C.white });
  L.page.drawRectangle({ x: M, y: L.y - 30, width: W, height: 30, color: oc });
  const ot = `OVERALL RESULT: ${summary.overall}`;
  L.draw(ot, M + (W - L.width(ot, 14, true)) / 2, L.y - 20, 14, { bold: true, color: C.white });
  let y = L.y - 46;
  for (const l of reasonLines) {
    L.draw(l, M + 12, y, 9.5);
    y -= 13;
  }
  const counts = [
    ["Items", summary.total],
    ["Pass", summary.pass],
    ["Fail", summary.fail],
    ["No result", summary.noResult],
    ["Unverified", summary.unverified],
  ] as const;
  const cw = (W - 24) / counts.length;
  counts.forEach(([label, n], i) => {
    const x = M + 12 + i * cw;
    L.draw(String(n), x, y - 12, 13, { bold: true, color: C.navy });
    L.draw(label, x + L.width(String(n), 13, true) + 5, y - 11, 8.5, { color: C.muted });
  });
  L.y -= boxH + 14;

  L.panel("Next test due", [
    ["Earliest due", summary.earliestNextTest ?? "No passed items with a next-test date"],
    ["Per item", "Listed against each item in the attached Test Report."],
  ]);
  L.y -= 14;

  const statement: Record<Summary["overall"], string> = {
    COMPLIANT:
      `This certifies that the electrical equipment listed in the attached Test Report was visually inspected and tested in accordance with ${business.standard} on the date(s) shown, and passed. Each item has been fitted with a compliance tag showing its next test due date.`,
    "FAILURES PRESENT":
      `The equipment listed in the attached Test Report was visually inspected and tested in accordance with ${business.standard}. Items marked PASS are compliant. Items marked FAIL did not pass and must be withdrawn from service until repaired and retested, or disposed of.`,
    INCOMPLETE:
      `The equipment listed in the attached Test Report was inspected and tested in accordance with ${business.standard}. Items marked PASS are compliant. Items marked NO RESULT were not tested and are not covered by this certificate.`,
    "REVIEW REQUIRED":
      "Some data in this report could not be read with confidence from the source PATLink export and is marked UNVERIFIED. This document must not be issued until every UNVERIFIED entry has been checked against the source PDF.",
  };
  L.para(statement[summary.overall], { size: 9.5, gap: 16 });

  // Signature + business details
  L.ensure(90);
  const sy = L.y;
  L.page.drawLine({ start: { x: M, y: sy - 34 }, end: { x: M + 200, y: sy - 34 }, thickness: 0.8, color: C.ink });
  L.draw(`Technician: ${business.technician || "NOT SET"}`, M, sy - 46, 9);
  L.page.drawLine({ start: { x: M + 230, y: sy - 34 }, end: { x: M + 330, y: sy - 34 }, thickness: 0.8, color: C.ink });
  L.draw("Date", M + 230, sy - 46, 9);
  const biz = [
    business.businessName,
    business.abn ? `ABN ${business.abn}` : "ABN NOT SET",
    [business.phone, business.email].filter(Boolean).join("  ·  "),
    [business.website, business.address].filter(Boolean).join("  ·  "),
  ].filter(Boolean);
  let by = sy - 8;
  for (const [i, line] of biz.entries()) {
    const size = i === 0 ? 10 : 8.5;
    L.draw(line, M + W - L.width(line, size, i === 0), by - size, size, { bold: i === 0, color: i === 0 ? C.navy : C.muted });
    by -= size + 4;
  }
  L.y = Math.min(sy - 56, by) - 6;
}

function drawItem(L: Layout, item: Item) {
  const st = displayStatus(item);
  const shown = new Set(["name", "(room) location", "location", "test code", "next test of appliance"]);
  const extra = item.fields.filter((f) => !shown.has(f.key.toLowerCase()));

  // Keep the item header and first block together where possible.
  L.ensure(70);
  const top = L.y;
  L.page.drawRectangle({ x: M, y: top - 22, width: W, height: 22, color: C.panel });
  L.page.drawRectangle({ x: M, y: top - 22, width: 3, height: 22, color: STATUS_COLOUR[st] });
  const idText = `#${item.node}  ${item.path.join(" / ")}`;
  L.draw(idText, M + 10, top - 15, 9, { color: C.muted });
  L.draw(item.name ?? "NAME NOT FOUND", M + 18 + L.width(idText, 9), top - 15, 10.5, {
    bold: true,
    color: item.name ? C.navy : C.unverified,
  });
  L.chip(st, M + W - 5, top - 4, STATUS_COLOUR[st]);
  L.y = top - 28;

  const info = [
    `Location: ${item.location ?? "—"}`,
    `Test code: ${item.testCode ?? "—"}`,
    `Next test: ${item.nextTest ?? "—"}`,
  ].join("     ");
  L.para(info, { x: M + 10, size: 8.5, color: C.ink });
  if (extra.length) L.para(kvText(extra), { x: M + 10, size: 8, color: C.muted });
  for (const iss of item.issues) {
    L.para(`UNVERIFIED — check source PDF: ${iss}`, { x: M + 10, size: 8.5, bold: true, color: C.unverified });
  }
  if (item.tests.length === 0) L.para("No test blocks recorded.", { x: M + 10, size: 8.5, color: C.muted });

  for (const t of item.tests) {
    L.ensure(40);
    L.y -= 3;
    const tStatus: DisplayStatus = t.issues.length > 0 || t.status === null ? "UNVERIFIED" : t.status;
    const head = `${t.name}   ${t.timestamp}${t.instrument ? `   Instrument ${t.instrument}` : ""}`;
    L.draw(head, M + 18, L.y - 9, 9, { bold: true, color: C.ink });
    L.chip(tStatus, M + W - 5, L.y + 1, STATUS_COLOUR[tStatus], 7.5);
    L.y -= 15;
    if (t.info.length) L.para(kvText(t.info), { x: M + 18, size: 8.5 });
    L.para(`Results:  ${t.results.length ? kvText(t.results) : "none"}`, { x: M + 18, size: 8.5 });
    if (t.parameters.length) L.para(`Parameters:  ${kvText(t.parameters)}`, { x: M + 18, size: 8.5, color: C.muted });
    for (const iss of t.issues) {
      L.para(`UNVERIFIED — check source PDF: ${iss}`, { x: M + 18, size: 8.5, bold: true, color: C.unverified });
    }
  }
  L.y -= 6;
  L.page.drawLine({ start: { x: M, y: L.y }, end: { x: M + W, y: L.y }, thickness: 0.5, color: C.line });
  L.y -= 8;
}

function drawReport(L: Layout, inp: RenderInput) {
  const { report, summary } = inp;
  L.reportPage();
  L.para(`Site: ${report.site ?? "NOT FOUND IN PDF"}`, { size: 11, bold: true, color: C.navy });
  L.para(
    `Source: ${inp.sourceFilename}   ·   ${summary.total} item(s)   ·   Pass ${summary.pass}   Fail ${summary.fail}   No result ${summary.noResult}   Unverified ${summary.unverified}`,
    { size: 8.5, color: C.muted, gap: 4 },
  );

  const attention = report.items.filter((i) => displayStatus(i) !== "PASS");
  if (report.issues.length || inp.reviewNotes.length || attention.length) {
    L.heading("Requires attention", C.red);
    for (const n of [...report.issues, ...inp.reviewNotes]) {
      L.para(`• ${n}`, { size: 8.5, color: C.unverified, bold: true });
    }
    for (const i of attention) {
      const st = displayStatus(i);
      const why = st === "UNVERIFIED" ? ` (${i.issues.join(" ")})` : "";
      L.para(`• ${st}: #${i.node} ${i.path.join("/")} ${i.name ?? ""}${why}`, { size: 8.5, color: STATUS_COLOUR[st] });
    }
    L.y -= 4;
  }

  const notes = report.groups.filter((g) => g.path.length > 0 && g.comment);
  if (notes.length) {
    L.heading("Location notes");
    for (const g of notes) L.para(`${g.path.join(" / ")}: ${g.comment}`, { size: 9 });
  }

  L.heading("Itemised results");
  L.para("All values are shown exactly as recorded in the PATLink export.", { size: 8, color: C.muted, gap: 4 });
  for (const item of report.items) drawItem(L, item);
}

/** Create the output document and its fonts (so callers can check glyph coverage first). */
export async function createDocument(fontUrls: { reg: string; bold: string }) {
  const doc = await PDFDocument.create();
  const fonts = await loadFonts(doc, fontUrls.reg, fontUrls.bold);
  return { doc, fonts };
}

export async function renderCertificate(doc: PDFDocument, f: Fonts, inp: RenderInput, logoUrl: string) {
  doc.setTitle(`Certificate of Compliance ${inp.certificateNo} ${inp.report.site ?? ""}`.trim());
  doc.setAuthor(inp.business.businessName);
  doc.setSubject(`${inp.business.standard} test and tag certificate`);
  doc.setProducer(`${inp.business.businessName} PATLink pipeline`);

  let logo: PDFImage | null = null;
  if (logoUrl) {
    try {
      const res = await fetch(logoUrl);
      if (res.ok) logo = await doc.embedPng(new Uint8Array(await res.arrayBuffer()));
    } catch (e) {
      console.warn("Logo unavailable, using vector crest:", e);
    }
  }

  const L = new Layout(doc, f, logo, inp.business);
  drawCertificate(L, inp);
  drawReport(L, inp);
  L.footers(inp.certificateNo);
  return await doc.save();
}
