// Branded Certificate of Compliance + Test Report (pdf-lib).
//
// Layout: page 1 is the certificate; then an asset register (one row per
// item) and detailed results (one table per item). Every reading, limit and
// setting is drawn from the exact source string. The renderer never formats,
// rounds or re-words a test value. Dates are shortened to the date part only
// in summary tables; full timestamps appear in the detailed results. A
// character the font can't draw is shown as [U+XXXX], and index.ts has
// already marked the report REVIEW REQUIRED if that happens.
//
// Preview locally without deploying: node preview/render-preview.mjs

import { PDFDocument, PDFFont, PDFImage, PDFPage, rgb, StandardFonts } from "npm:pdf-lib@1.17.1";
import fontkit from "npm:@pdf-lib/fontkit@1.1.1";
import type { BusinessConfig } from "./config.ts";
import { dateKey, displayStatus } from "./summary.ts";
import type { ClientLookup, DisplayStatus, Item, KV, ParsedReport, Summary, TestBlock } from "./types.ts";

type RGB = ReturnType<typeof rgb>;
const hex = (h: string): RGB =>
  rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);

const C = {
  navy: hex("#0B1F3A"),
  navySoft: hex("#EDF1F6"),
  red: hex("#8B1A1A"),
  gold: hex("#C9A227"),
  ink: hex("#1F2933"),
  body: hex("#3E4C59"),
  muted: hex("#7B8794"),
  rule: hex("#D9DEE5"),
  zebra: hex("#F6F8FA"),
  white: rgb(1, 1, 1),
  pass: hex("#18794E"),
  fail: hex("#B42318"),
  noResult: hex("#6B7280"),
  unverified: hex("#C4520F"),
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

const PAGE: [number, number] = [595.28, 841.89];
const TOP = PAGE[1];
const M = 42; // side margin
const W = PAGE[0] - 2 * M;
const BOTTOM = 62; // keep clear for footer

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

/** Load the Unicode TTFs if reachable, else fall back to Helvetica. */
export async function loadFonts(doc: PDFDocument, regUrl: string, boldUrl: string): Promise<Fonts> {
  try {
    const [r, b] = await Promise.all([fetchFont(regUrl), fetchFont(boldUrl)]);
    doc.registerFontkit(fontkit);
    const reg = await doc.embedFont(r, { subset: true });
    const bold = await doc.embedFont(b, { subset: true });
    return { reg, bold, unicode: true };
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

/** "14.09.2027 00:00:00" -> "14.09.2027". Anything else is returned unchanged. */
export function datePart(s: string | null): string | null {
  if (!s) return s;
  const m = /^(\d{1,2}\.\d{1,2}\.\d{4})\b/.exec(s.trim());
  return m ? m[1] : s;
}

function testStatus(t: TestBlock): DisplayStatus {
  return t.issues.length > 0 || t.status === null ? "UNVERIFIED" : t.status;
}

const isLimit = (k: KV) => /^limit$/i.test(k.key);
const kvLines = (kvs: KV[]) => kvs.map((k) => `${k.key}: ${k.value}`).join("\n");

type Cell = { text: string; bold?: boolean; color?: RGB } | { pill: DisplayStatus };
interface Col {
  title: string;
  w: number;
}

class Layout {
  doc: PDFDocument;
  f: Fonts;
  charset: Set<number>;
  page!: PDFPage;
  y = 0;
  pages: PDFPage[] = [];
  logo: PDFImage | null;
  inp: RenderInput;
  /** Re-drawn after a page break, e.g. a table header. */
  continuation: (() => void) | null = null;

  constructor(doc: PDFDocument, f: Fonts, logo: PDFImage | null, inp: RenderInput) {
    this.doc = doc;
    this.f = f;
    this.charset = new Set(f.reg.getCharacterSet());
    this.logo = logo;
    this.inp = inp;
  }

  // ---- text primitives -------------------------------------------------

  /** Make a string drawable without altering any supported character. */
  s(text: string): string {
    let out = "";
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      if (cp === 10) out += "\n";
      else if (cp < 32) out += " ";
      else if (this.charset.has(cp)) out += ch;
      else out += `[U+${cp.toString(16).toUpperCase().padStart(4, "0")}]`;
    }
    return out;
  }

  font(bold?: boolean) {
    return bold ? this.f.bold : this.f.reg;
  }

  width(text: string, size: number, bold = false): number {
    return this.font(bold).widthOfTextAtSize(this.s(text), size);
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

  text(t: string, x: number, y: number, size: number, o: { bold?: boolean; color?: RGB; opacity?: number } = {}) {
    this.page.drawText(this.s(t), {
      x,
      y,
      size,
      font: this.font(o.bold),
      color: o.color ?? C.ink,
      opacity: o.opacity ?? 1,
    });
  }

  textRight(t: string, xRight: number, y: number, size: number, o: { bold?: boolean; color?: RGB; opacity?: number } = {}) {
    this.text(t, xRight - this.width(t, size, o.bold), y, size, o);
  }

  textCenter(t: string, y: number, size: number, o: { bold?: boolean; color?: RGB } = {}) {
    this.text(t, (PAGE[0] - this.width(t, size, o.bold)) / 2, y, size, o);
  }

  /** Wrapped paragraph at the cursor. */
  para(t: string, o: { x?: number; width?: number; size?: number; bold?: boolean; color?: RGB; gap?: number } = {}) {
    const size = o.size ?? 9.5;
    const lh = size * 1.4;
    const x = o.x ?? M;
    for (const l of this.wrap(t, size, o.width ?? W - (x - M), o.bold)) {
      this.ensure(lh);
      this.text(l, x, this.y - size, size, o);
      this.y -= lh;
    }
    this.y -= o.gap ?? 0;
  }

  // ---- shapes ----------------------------------------------------------

  rect(x: number, yTop: number, w: number, h: number, fill: RGB | undefined, border?: RGB, bw = 0.75) {
    this.page.drawRectangle({ x, y: yTop - h, width: w, height: h, color: fill, borderColor: border, borderWidth: border ? bw : 0 });
  }

  round(x: number, yTop: number, w: number, h: number, r: number, fill: RGB | undefined, border?: RGB, bw = 0.75) {
    const p = `M ${r} 0 H ${w - r} Q ${w} 0 ${w} ${r} V ${h - r} Q ${w} ${h} ${w - r} ${h} H ${r} Q 0 ${h} 0 ${h - r} V ${r} Q 0 0 ${r} 0 Z`;
    this.page.drawSvgPath(p, { x, y: yTop, color: fill, borderColor: border, borderWidth: border ? bw : 0 });
  }

  hline(y: number, color = C.rule, thickness = 0.6, x1 = M, x2 = M + W) {
    this.page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness, color });
  }

  /** Status pill, left edge at x, vertically centred on yMid. Returns width. */
  pill(status: DisplayStatus, x: number, yMid: number, size = 7) {
    const w = this.width(status, size, true) + 12;
    const h = size + 6.5;
    this.round(x, yMid + h / 2, w, h, h / 2, STATUS_COLOUR[status]);
    this.text(status, x + 6, yMid - size * 0.36, size, { bold: true, color: C.white });
    return w;
  }

  pillWidth(status: DisplayStatus, size = 7) {
    return this.width(status, size, true) + 12;
  }

  logoAt(x: number, yTop: number, h: number) {
    if (this.logo) {
      const d = this.logo.scale(1);
      this.page.drawImage(this.logo, { x, y: yTop - h, width: (d.width / d.height) * h, height: h });
      return (d.width / d.height) * h;
    }
    // Fallback crest if LOGO_URL is not set or unreachable.
    const s = h / 70;
    this.page.drawSvgPath("M30 0 L60 8 L60 34 C60 52 46 64 30 70 C14 64 0 52 0 34 L0 8 Z", {
      x,
      y: yTop,
      scale: s,
      color: C.navy,
      borderColor: C.gold,
      borderWidth: 2,
    });
    this.page.drawSvgPath("M36 10 L20 40 L30 40 L24 62 L42 30 L32 30 L40 10 Z", { x, y: yTop, scale: s, color: C.gold });
    return 60 * s;
  }

  // ---- pages -----------------------------------------------------------

  addPage() {
    this.page = this.doc.addPage(PAGE);
    this.pages.push(this.page);
  }

  /** Report page with running header. */
  reportPage() {
    this.addPage();
    const { business, report, certificateNo } = this.inp;
    const lw = this.logoAt(M, TOP - 18, 38);
    this.text("TEST REPORT", M + lw + 10, TOP - 33, 13, { bold: true, color: C.navy });
    this.text(`${report.site ?? "Site not found"}  ·  Certificate ${certificateNo}`, M + lw + 10, TOP - 46, 8, { color: C.muted });
    this.textRight(business.businessName.toUpperCase(), M + W, TOP - 33, 9, { bold: true, color: C.navy });
    this.textRight(business.tagline, M + W, TOP - 45, 7.5, { bold: true, color: C.gold });
    this.hline(TOP - 64, C.gold, 1.2);
    this.y = TOP - 82;
  }

  ensure(h: number) {
    if (this.y - h < BOTTOM) {
      this.reportPage();
      this.continuation?.();
    }
  }

  sectionTitle(title: string, subtitle?: string) {
    this.ensure(subtitle ? 60 : 44);
    this.text(title, M, this.y - 15, 15, { bold: true, color: C.navy });
    this.y -= 22;
    if (subtitle) {
      this.text(subtitle, M, this.y - 9, 8.5, { color: C.muted });
      this.y -= 16;
    }
    this.y -= 6;
  }

  // ---- table -----------------------------------------------------------

  /** Height a table() call will take, for keeping blocks together. */
  tableHeight(cols: Col[], rows: Cell[][], o: { size?: number; header?: "dark" | "light" } = {}) {
    const size = o.size ?? 8.5;
    const lh = size * 1.32;
    let h = o.header === "light" ? 18 : 20;
    for (const row of rows) {
      const lines = Math.max(1, ...row.map((c, j) => ("pill" in c ? 1 : this.wrap(c.text, size, cols[j].w - 12, c.bold).length)));
      h += Math.max(22, lines * lh + 11);
    }
    return h;
  }

  table(cols: Col[], rows: Cell[][], o: { size?: number; header?: "dark" | "light"; zebra?: boolean } = {}) {
    const size = o.size ?? 8.5;
    const lh = size * 1.32;
    const padX = 6;
    const headerH = o.header === "light" ? 18 : 20;
    const drawHeader = () => {
      let x = M;
      if (o.header === "light") {
        this.rect(M, this.y, W, headerH, C.zebra);
        this.hline(this.y - headerH, C.rule, 0.8);
      } else {
        this.rect(M, this.y, W, headerH, C.navy);
      }
      for (const c of cols) {
        this.text(c.title.toUpperCase(), x + padX, this.y - headerH / 2 - 2.6, 6.8, {
          bold: true,
          color: o.header === "light" ? C.muted : C.white,
        });
        x += c.w;
      }
      this.y -= headerH;
    };

    const prev = this.continuation;
    this.ensure(headerH + 26);
    drawHeader();
    this.continuation = drawHeader;

    rows.forEach((row, i) => {
      const wrapped = row.map((c, j) => ("pill" in c ? [] : this.wrap(c.text, size, cols[j].w - padX * 2, c.bold)));
      const lines = Math.max(1, ...wrapped.map((w) => w.length));
      const h = Math.max(22, lines * lh + 11);
      this.ensure(h);
      if (o.zebra !== false && i % 2 === 1) this.rect(M, this.y, W, h, C.zebra);
      let x = M;
      row.forEach((c, j) => {
        if ("pill" in c) {
          this.pill(c.pill, x + padX, this.y - h / 2);
        } else {
          wrapped[j].forEach((l, k) => {
            this.text(l, x + padX, this.y - 7 - size * 0.8 - k * lh, size, { bold: c.bold, color: c.color ?? C.ink });
          });
        }
        x += cols[j].w;
      });
      this.y -= h;
      this.hline(this.y, C.rule, 0.5);
    });
    this.continuation = prev;
  }

  footers() {
    const n = this.pages.length;
    const { business, certificateNo } = this.inp;
    this.pages.forEach((p, i) => {
      p.drawLine({ start: { x: M, y: 44 }, end: { x: M + W, y: 44 }, thickness: 0.6, color: C.rule });
      const name = `${business.businessName} · `;
      p.drawText(this.s(name), { x: M, y: 30, size: 7.5, font: this.f.bold, color: C.navy });
      p.drawText(this.s(business.tagline), {
        x: M + this.width(name, 7.5, true),
        y: 30,
        size: 7.5,
        font: this.f.bold,
        color: C.gold,
      });
      const right = `Certificate ${certificateNo}  ·  Page ${i + 1} of ${n}`;
      p.drawText(this.s(right), { x: M + W - this.width(right, 7.5), y: 30, size: 7.5, font: this.f.reg, color: C.muted });
    });
  }
}

// ---- page 1: certificate -------------------------------------------------

function drawCertificate(L: Layout) {
  const { report, summary, client, business, certificateNo, issuedAt } = L.inp;
  L.addPage();

  // Letterhead
  L.rect(0, TOP, PAGE[0], 7, C.navy);
  L.rect(0, TOP - 7, PAGE[0], 2, C.gold);
  L.logoAt(M, TOP - 24, 96);
  let ry = TOP - 46;
  const right = (t: string, size: number, o: { bold?: boolean; color?: RGB } = {}) => {
    L.textRight(t, M + W, ry, size, o);
    ry -= size + 4.5;
  };
  right(business.businessName.toUpperCase(), 15, { bold: true, color: C.navy });
  right("Electrical Test & Tag Compliance", 9, { color: C.body });
  if (business.address) right(business.address, 9, { color: C.body });
  right(business.abn ? `ABN ${business.abn}` : "ABN NOT SET", 9, { color: business.abn ? C.body : C.unverified });
  const contact = [business.phone, business.email].filter(Boolean).join("  ·  ");
  if (contact) right(contact, 9, { color: C.body });
  if (business.website) right(business.website, 9, { bold: true, color: C.navy });

  let y = TOP - 140;
  L.hline(y, C.rule, 0.8);

  // Title
  y -= 40;
  L.textCenter("CERTIFICATE OF COMPLIANCE", y, 24, { bold: true, color: C.navy });
  y -= 18;
  L.textCenter(`In-service inspection and testing of electrical equipment  ·  ${business.standard}`, y, 9.5, { color: C.muted });
  y -= 11;
  L.hline(y, C.gold, 1.5, PAGE[0] / 2 - 28, PAGE[0] / 2 + 28);
  y -= 17;
  L.textCenter(`Certificate No. ${certificateNo}      Issued ${issuedAt}`, y, 8.5, { color: C.muted });
  y -= 18;

  if (summary.overall === "REVIEW REQUIRED") {
    const msg = "DRAFT: UNVERIFIED DATA. DO NOT ISSUE UNTIL CHECKED AGAINST THE SOURCE PDF.";
    L.round(M, y, W, 24, 4, C.unverified);
    L.textCenter(msg, y - 15.5, 8.5, { bold: true, color: C.white });
    y -= 32;
  }

  // Result banner
  const bh = 62;
  L.round(M, y, W, bh, 6, OVERALL_COLOUR[summary.overall]);
  L.text("OVERALL RESULT", M + 20, y - 22, 7.5, { bold: true, color: C.white, opacity: 0.85 });
  L.text(summary.overall, M + 20, y - 46, 22, { bold: true, color: C.white });
  L.textRight(`${summary.pass} of ${summary.total}`, M + W - 20, y - 34, 22, { bold: true, color: C.white });
  L.textRight("items passed", M + W - 20, y - 48, 8, { color: C.white, opacity: 0.85 });
  y -= bh + 10;
  L.y = y;
  if (summary.overall !== "COMPLIANT") {
    L.para(summary.overallReason, { size: 9, color: OVERALL_COLOUR[summary.overall], bold: true, gap: 2 });
  }
  y = L.y - 4;

  // Details grid
  const c = client.client;
  const notFound = "NOT FOUND: check Clients.md";
  const first = datePart(summary.firstTest);
  const last = datePart(summary.lastTest);
  const tested = !first ? "—" : first === last ? first : `${first} to ${last}`;
  const instrument = [report.instrumentModel, report.instrumentSerials.length ? `S/N ${report.instrumentSerials.join(", ")}` : null]
    .filter(Boolean)
    .join("  ·  ") || "Not stated in source PDF";
  type Field = [string, string, RGB?];
  const grid: [Field, Field][] = [
    [["Client", c?.company || notFound, c?.company ? undefined : C.unverified], ["Site", report.site ?? "NOT FOUND IN PDF", report.site ? undefined : C.unverified]],
    [["Site address", c?.address || notFound, c?.address ? undefined : C.unverified], ["Site contact", [c?.contact, c?.email].filter(Boolean).join("  ·  ") || "—"]],
    [["Date(s) of testing", tested], ["Next test due", summary.earliestNextTest ? `${datePart(summary.earliestNextTest)} (earliest item)` : "—"]],
    [["Test standard", business.standard], ["Test instrument", instrument]],
    [["Tested by", business.technician || "NOT SET", business.technician ? undefined : C.unverified], ["Items tested", String(summary.total)]],
  ];
  const colW = W / 2;
  L.hline(y, C.rule, 0.8);
  for (const pair of grid) {
    const wrapped = pair.map(([, v]) => L.wrap(v, 10, colW - 20, true));
    const h = 22 + Math.max(...wrapped.map((w) => w.length)) * 13 + 6;
    pair.forEach(([label, , color], i) => {
      const x = M + i * colW + (i ? 14 : 0);
      L.text(label.toUpperCase(), x, y - 14, 7, { bold: true, color: C.muted });
      wrapped[i].forEach((l, k) => L.text(l, x, y - 28 - k * 13, 10, { bold: true, color: color ?? C.ink }));
    });
    y -= h;
    L.hline(y, C.rule, 0.6);
  }
  y -= 14;

  // Stat tiles
  const tiles: [string, number, RGB][] = [
    ["Items tested", summary.total, C.navy],
    ["Passed", summary.pass, C.pass],
    ["Failed", summary.fail, summary.fail ? C.fail : C.navy],
    ["Not tested", summary.noResult, summary.noResult ? C.noResult : C.navy],
  ];
  if (summary.unverified) tiles.push(["Unverified", summary.unverified, C.unverified]);
  const gap = 8;
  const tw = (W - gap * (tiles.length - 1)) / tiles.length;
  tiles.forEach(([label, n, col], i) => {
    const x = M + i * (tw + gap);
    L.round(x, y, tw, 50, 4, C.zebra, C.rule);
    L.text(String(n), x + 12, y - 28, 20, { bold: true, color: col });
    L.text(label.toUpperCase(), x + 12, y - 41, 6.8, { bold: true, color: C.muted });
  });
  y -= 50 + 18;

  // Declaration
  const statement: Record<Summary["overall"], string> = {
    COMPLIANT:
      `This certifies that the electrical equipment listed in the attached Test Report was visually inspected and tested in accordance with ${business.standard} on the date(s) shown and passed. Each item has been fitted with a compliance tag showing its next test due date.`,
    "FAILURES PRESENT":
      `The electrical equipment listed in the attached Test Report was visually inspected and tested in accordance with ${business.standard}. Items marked PASS are compliant. Items marked FAIL did not pass and must be withdrawn from service until repaired and retested, or disposed of.`,
    INCOMPLETE:
      `The electrical equipment listed in the attached Test Report was inspected and tested in accordance with ${business.standard}. Items marked PASS are compliant. Items marked NO RESULT were not tested and are not covered by this certificate.`,
    "REVIEW REQUIRED":
      "Some data in this report could not be read with confidence from the source export and is marked UNVERIFIED. This document must not be issued until every UNVERIFIED entry has been checked against the source PDF.",
  };
  L.text("DECLARATION", M, y - 8, 7, { bold: true, color: C.muted });
  L.y = y - 14;
  L.para(statement[summary.overall], { size: 9.5, color: C.body });

  // Signature block, anchored above the footer.
  const sy = Math.min(L.y - 40, BOTTOM + 52);
  const cols = [
    { label: "Tested by", value: business.technician || "", w: 200 },
    { label: "Signature", value: "", w: 160 },
    { label: "Date", value: "", w: W - 200 - 160 - 40 },
  ];
  let x = M;
  for (const col of cols) {
    if (col.value) L.text(col.value, x, sy + 6, 10, { bold: true, color: C.ink });
    L.hline(sy, C.ink, 0.7, x, x + col.w);
    L.text(col.label.toUpperCase(), x, sy - 11, 7, { bold: true, color: C.muted });
    x += col.w + 20;
  }
}

// ---- asset register --------------------------------------------------------

function latestTest(item: Item): string | null {
  let best: string | null = null;
  let bestKey = -Infinity;
  for (const t of item.tests) {
    const k = dateKey(t.timestamp);
    if (k !== null && k > bestKey) {
      bestKey = k;
      best = t.timestamp;
    }
  }
  return best;
}

function drawAttention(L: Layout) {
  const { report, reviewNotes } = L.inp;
  const items = report.items.filter((i) => displayStatus(i) !== "PASS");
  const lines = [
    ...report.issues,
    ...reviewNotes,
    ...items.map((i) => {
      const st = displayStatus(i);
      const why = st === "UNVERIFIED" ? `: ${i.issues.join(" ")}` : "";
      return `${st}: ${i.path.at(-1) ?? ""} ${i.name ?? ""}${why}`;
    }),
  ];
  if (!lines.length) return;
  const size = 8.5;
  const wrapped = lines.map((l) => L.wrap(`•  ${l}`, size, W - 28));
  const h = 30 + wrapped.flat().length * size * 1.4 + 8;
  L.ensure(h + 10);
  L.round(M, L.y, W, h, 5, hex("#FFF7ED"), C.unverified, 1);
  L.text("REQUIRES ATTENTION", M + 14, L.y - 19, 8, { bold: true, color: C.unverified });
  let y = L.y - 34;
  for (const w of wrapped) {
    for (const l of w) {
      L.text(l, M + 14, y, size, { color: C.ink });
      y -= size * 1.4;
    }
  }
  L.y -= h + 14;
}

function drawRegister(L: Layout) {
  const { report, summary } = L.inp;
  L.reportPage();
  L.sectionTitle(
    "Asset register",
    `${summary.total} item(s) inspected and tested  ·  ${summary.pass} passed  ·  ${summary.fail} failed  ·  ${summary.noResult} not tested`,
  );
  drawAttention(L);

  const cols: Col[] = [
    { title: "Asset", w: 44 },
    { title: "Description", w: 120 },
    { title: "Location", w: 96 },
    { title: "Class", w: 60 },
    { title: "Tested", w: 62 },
    { title: "Next due", w: 62 },
  ];
  cols.push({ title: "Result", w: W - cols.reduce((a, c) => a + c.w, 0) });
  const rows: Cell[][] = report.items.map((i) => [
    { text: i.path.at(-1) ?? "—", bold: true, color: C.navy },
    { text: i.name ?? "NAME NOT FOUND", color: i.name ? C.ink : C.unverified },
    { text: i.location ?? (i.path.slice(0, -1).join(" / ") || "—") },
    { text: i.testCode ?? "—" },
    { text: datePart(latestTest(i)) ?? "—" },
    { text: datePart(i.nextTest) ?? "—" },
    { pill: displayStatus(i) },
  ]);
  L.table(cols, rows);

  const notes = report.groups.filter((g) => g.path.length > 0 && g.comment);
  if (notes.length) {
    L.y -= 12;
    L.ensure(30);
    L.text("LOCATION NOTES", M, L.y - 8, 7, { bold: true, color: C.muted });
    L.y -= 14;
    for (const g of notes) L.para(`${g.path.join(" / ")}: ${g.comment}`, { size: 8.5, color: C.body });
  }
  L.y -= 18;
}

// ---- detailed results ----------------------------------------------------

function itemTable(L: Layout, item: Item): { cols: Col[]; rows: Cell[][] } {
  const mainSerial = L.inp.report.instrumentSerials[0];
  const cols: Col[] = [
    { title: "Test", w: 88 },
    { title: "Date / time", w: 78 },
    { title: "Reading", w: 108 },
    { title: "Limit", w: 58 },
  ];
  const resultW = 80; // fits the UNVERIFIED pill
  cols.push({ title: "Settings", w: W - cols.reduce((a, c) => a + c.w, 0) - resultW });
  cols.push({ title: "Result", w: resultW });
  const rows: Cell[][] = item.tests.map((t) => {
    const reading = [...t.info, ...t.results.filter((k) => !isLimit(k))];
    const limit = t.results.filter(isLimit);
    const settings = [...t.parameters];
    if (t.instrument && t.instrument !== mainSerial) settings.push({ key: "Instrument", value: t.instrument });
    return [
      { text: t.name, bold: true },
      { text: t.timestamp, color: C.body },
      { text: reading.length ? kvLines(reading) : "—" },
      { text: limit.length ? limit.map((k) => k.value).join("\n") : "—" },
      { text: settings.length ? kvLines(settings) : "—", color: C.body },
      { pill: testStatus(t) },
    ];
  });
  return { cols, rows };
}

function drawItemDetail(L: Layout, item: Item) {
  const st = displayStatus(item);
  const shown = new Set(["name", "(room) location", "location", "test code", "next test of appliance"]);
  const extra = item.fields.filter((f) => !shown.has(f.key.toLowerCase()));
  const notes = [
    ...(extra.length ? [{ t: extra.map((k) => `${k.key}: ${k.value}`).join("   ·   "), warn: false }] : []),
    ...item.issues.map((i) => ({ t: `UNVERIFIED — check source PDF: ${i}`, warn: true })),
    ...item.tests.flatMap((t) => t.issues.map((i) => ({ t: `UNVERIFIED — ${t.name}: ${i}`, warn: true }))),
  ];
  const { cols, rows } = itemTable(L, item);
  const tableOpts = { header: "light" as const, size: 8 };

  // Keep the whole card on one page when it fits on a fresh page.
  const cardH = 26 + 6;
  const notesH = notes.reduce((a, n) => a + L.wrap(n.t, 8.5, W - 8).length * 8.5 * 1.4, 0);
  const bodyH = rows.length ? L.tableHeight(cols, rows, tableOpts) : 20;
  const total = cardH + notesH + bodyH + 16;
  if (L.y - total < BOTTOM && total <= TOP - 82 - BOTTOM) L.reportPage();
  else L.ensure(cardH + 60);

  const h = 26;
  L.round(M, L.y, W, h, 4, C.navySoft);
  L.rect(M, L.y, 3.5, h, STATUS_COLOUR[st]);
  const id = item.path.at(-1) ?? "—";
  L.text(id, M + 14, L.y - 17, 10.5, { bold: true, color: C.navy });
  L.text(item.name ?? "NAME NOT FOUND", M + 14 + L.width(id, 10.5, true) + 10, L.y - 17, 10.5, {
    bold: true,
    color: item.name ? C.ink : C.unverified,
  });
  const pw = L.pillWidth(st, 7.5);
  L.pill(st, M + W - 10 - pw, L.y - h / 2, 7.5);
  const meta = [item.testCode, item.location, item.nextTest ? `Next due ${datePart(item.nextTest)}` : null]
    .filter(Boolean)
    .join("   ·   ");
  L.textRight(meta, M + W - 20 - pw, L.y - 16.5, 8, { color: C.body });
  L.y -= cardH;

  for (const n of notes) {
    L.para(n.t, { x: M + 8, size: n.warn ? 8.5 : 8, bold: n.warn, color: n.warn ? C.unverified : C.muted });
  }
  if (rows.length) L.table(cols, rows, { ...tableOpts, zebra: false });
  else L.para("No tests recorded for this item.", { x: M + 8, size: 8.5, color: C.muted });
  L.y -= 16;
}

function drawDetails(L: Layout) {
  L.sectionTitle("Detailed test results", "Readings, limits and settings exactly as recorded by the test instrument.");
  for (const item of L.inp.report.items) drawItemDetail(L, item);

  // Closing notes
  const { business, sourceFilename } = L.inp;
  L.ensure(70);
  L.y -= 4;
  L.hline(L.y, C.rule, 0.6);
  L.y -= 14;
  L.text("NOTES", M, L.y - 7, 7, { bold: true, color: C.muted });
  L.y -= 14;
  const notes = [
    `Testing performed in accordance with ${business.standard}. Readings are reproduced exactly as recorded by the test instrument (source: ${sourceFilename}).`,
    "Equipment marked FAIL must be withdrawn from service and not used until repaired and retested, or disposed of.",
    "Each item's next test due date is shown on its compliance tag and in the asset register above.",
  ];
  for (const n of notes) L.para(`•  ${n}`, { size: 8, color: C.body, gap: 1 });
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

  const L = new Layout(doc, f, logo, inp);
  drawCertificate(L);
  drawRegister(L);
  drawDetails(L);
  L.footers();
  return await doc.save();
}
