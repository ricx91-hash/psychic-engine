// Browser stand-in for the subset of pdf-lib that render.ts uses. Draws each
// page as SVG so the layout can be screenshotted locally. Text is measured
// with the same Liberation Sans files the deployed function embeds.

const canvas = document.createElement("canvas");
const ctx = canvas.getContext("2d");

export const rgb = (r, g, b) => ({ r, g, b });
const css = (c, opacity = 1) =>
  c ? `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${opacity})` : "none";
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const StandardFonts = { Helvetica: "Helvetica", HelveticaBold: "Helvetica-Bold" };

class Font {
  constructor(family, weight) {
    this.family = family;
    this.weight = weight;
  }
  widthOfTextAtSize(text, size) {
    ctx.font = `${this.weight} ${size}px '${this.family}'`;
    return ctx.measureText(text).width;
  }
  heightAtSize(size) {
    return size;
  }
  getCharacterSet() {
    const out = [];
    for (let i = 32; i < 0x2700; i++) out.push(i);
    return out;
  }
}

class Image {
  constructor(url, w, h) {
    this.url = url;
    this.width = w;
    this.height = h;
  }
  scale(n) {
    return { width: this.width * n, height: this.height * n };
  }
}

class Page {
  constructor(size) {
    [this.w, this.h] = size;
    this.els = [];
  }
  getSize() {
    return { width: this.w, height: this.h };
  }
  drawText(t, o) {
    const f = o.font;
    this.els.push(
      `<text x="${o.x}" y="${this.h - o.y}" font-family="${f.family}" font-weight="${f.weight}" font-size="${o.size}" fill="${css(o.color, o.opacity ?? 1)}" xml:space="preserve">${esc(t)}</text>`,
    );
  }
  drawRectangle(o) {
    this.els.push(
      `<rect x="${o.x}" y="${this.h - o.y - o.height}" width="${o.width}" height="${o.height}" fill="${css(o.color, o.opacity ?? 1)}" stroke="${css(o.borderColor, o.borderOpacity ?? 1)}" stroke-width="${o.borderColor ? (o.borderWidth ?? 1) : 0}"/>`,
    );
  }
  drawLine(o) {
    this.els.push(
      `<line x1="${o.start.x}" y1="${this.h - o.start.y}" x2="${o.end.x}" y2="${this.h - o.end.y}" stroke="${css(o.color, o.opacity ?? 1)}" stroke-width="${o.thickness ?? 1}"/>`,
    );
  }
  drawSvgPath(d, o) {
    const s = o.scale ?? 1;
    this.els.push(
      `<path transform="translate(${o.x},${this.h - o.y}) scale(${s})" d="${d}" fill="${css(o.color, o.opacity ?? 1)}" stroke="${css(o.borderColor)}" stroke-width="${o.borderColor ? (o.borderWidth ?? 1) / s : 0}"/>`,
    );
  }
  drawImage(img, o) {
    this.els.push(
      `<image href="${img.url}" x="${o.x}" y="${this.h - o.y - o.height}" width="${o.width}" height="${o.height}"/>`,
    );
  }
  svg() {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${this.w}" height="${this.h}" viewBox="0 0 ${this.w} ${this.h}"><rect width="100%" height="100%" fill="#fff"/>${this.els.join("")}</svg>`;
  }
}

let fontCount = 0;
export class PDFDocument {
  static async create() {
    return new PDFDocument();
  }
  constructor() {
    this.pages = [];
  }
  registerFontkit() {}
  setTitle() {}
  setAuthor() {}
  setSubject() {}
  setProducer() {}
  addPage(size) {
    const p = new Page(size);
    this.pages.push(p);
    return p;
  }
  async embedFont(bytes) {
    if (typeof bytes === "string") return new Font("Liberation Sans", bytes.includes("Bold") ? 700 : 400);
    // Second embedded font is the bold one (loadFonts embeds regular then bold).
    const weight = fontCount++ % 2 === 0 ? 400 : 700;
    return new Font("Liberation Sans", weight);
  }
  async embedPng(bytes) {
    const blob = new Blob([bytes], { type: "image/png" });
    const url = await new Promise((r) => {
      const fr = new FileReader();
      fr.onload = () => r(fr.result);
      fr.readAsDataURL(blob);
    });
    const im = new window.Image();
    im.src = url;
    await im.decode();
    return new Image(url, im.naturalWidth, im.naturalHeight);
  }
  async save() {
    return this.pages.map((p) => p.svg());
  }
}
