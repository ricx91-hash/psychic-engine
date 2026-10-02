// Turn the PATLink PDF into ordered text lines for parser.ts.
// pdf.js (via unpdf) returns positioned text fragments. Fragments are grouped
// into lines by their baseline, top-to-bottom, left-to-right within a page.

import { getDocumentProxy } from "npm:unpdf@0.12.1";

interface Frag {
  str: string;
  x: number;
  y: number;
  w: number;
}

const LINE_TOLERANCE = 2; // pt: fragments within this vertical distance share a line
const SPACE_GAP = 1; // pt: horizontal gap that implies a space between fragments

export async function extractLines(pdfBytes: Uint8Array): Promise<string[]> {
  const pdf = await getDocumentProxy(new Uint8Array(pdfBytes));
  const out: string[] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const frags: Frag[] = [];
    for (const it of content.items as Array<Record<string, unknown>>) {
      if (typeof it.str !== "string" || it.str === "") continue;
      const t = it.transform as number[];
      frags.push({ str: it.str, x: t[4], y: t[5], w: (it.width as number) ?? 0 });
    }
    frags.sort((a, b) => b.y - a.y || a.x - b.x);

    let line: Frag[] = [];
    const flush = () => {
      if (line.length === 0) return;
      line.sort((a, b) => a.x - b.x);
      let text = line[0].str;
      for (let i = 1; i < line.length; i++) {
        const prev = line[i - 1];
        const gap = line[i].x - (prev.x + prev.w);
        const needsSpace = gap > SPACE_GAP && !text.endsWith(" ") && !line[i].str.startsWith(" ");
        text += (needsSpace ? " " : "") + line[i].str;
      }
      out.push(text);
      line = [];
    };
    for (const f of frags) {
      if (line.length > 0 && Math.abs(line[0].y - f.y) > LINE_TOLERANCE) flush();
      line.push(f);
    }
    flush();
  }
  return out;
}
