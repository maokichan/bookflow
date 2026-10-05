// 页图渲染：PDF → data/pages/pNNN.png（工作台对照视图用）。
// 走 pdfjs + @napi-rs/canvas 路径渲染（字形路径化，Node 无 FontFace 也可用）。
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { createCanvas, DOMMatrix, Path2D, ImageData } from "@napi-rs/canvas";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./model.ts";
import { argBook, getBook, pathsFor } from "./library.ts";

(globals() as any).DOMMatrix ??= DOMMatrix;
(globals() as any).Path2D ??= Path2D;
(globals() as any).ImageData ??= ImageData;
function globals(): Record<string, unknown> {
  return globalThis as unknown as Record<string, unknown>;
}

// pdfjs legacy 的默认 NodeCanvasFactory 硬性 require("canvas")（node-canvas，Windows/Node24 难装）。
// 这里注入同契约的 @napi-rs/canvas 工厂：getDocument({ CanvasFactory }) 是 4.8 的正式参数。
class NapiCanvasFactory {
  constructor(_: { ownerDocument?: unknown; enableHWA?: boolean } = {}) {}
  create(width: number, height: number) {
    if (width <= 0 || height <= 0) throw new Error("Invalid canvas size");
    const canvas = createCanvas(width, height);
    return { canvas, context: canvas.getContext("2d") };
  }
  reset(cc: { canvas: any }, width: number, height: number) {
    if (!cc.canvas) throw new Error("Canvas is not specified");
    if (width <= 0 || height <= 0) throw new Error("Invalid canvas size");
    cc.canvas.width = width;
    cc.canvas.height = height;
  }
  destroy(cc: { canvas: any; context: any }) {
    if (!cc.canvas) throw new Error("Canvas is not specified");
    cc.canvas.width = 0;
    cc.canvas.height = 0;
    cc.canvas = null;
    cc.context = null;
  }
}

const BOOK = argBook();
const PDF_PATH = pathsFor(BOOK).source; // 科目源在注册表里，已随导入复制为 source.pdf
const SCALE = Number(process.argv[2] ?? 2); // 2× ≈ 144 DPI，屏幕对照够用

const buf = readFileSync(PDF_PATH);
const doc = await pdfjsLib.getDocument({
  data: new Uint8Array(buf),
  useSystemFonts: false,
  disableFontFace: true,
  isEvalSupported: false,
  CanvasFactory: NapiCanvasFactory,
  standardFontDataUrl: path.join(ROOT, "node_modules", "pdfjs-dist", "standard_fonts") + path.sep,
}).promise;

const P = pathsFor(BOOK);
mkdirSync(P.pagesDir, { recursive: true });
for (let p = 1; p <= doc.numPages; p++) {
  const page = await doc.getPage(p);
  const vp = page.getViewport({ scale: SCALE });
  const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx as any, viewport: vp, background: "#ffffff" } as any).promise;
  const out = path.join(P.pagesDir, `p${String(p).padStart(3, "0")}.png`);
  const png = canvas.encodeSync("png");
  writeFileSync(out, png);
  console.log(`p${p} → ${out} (${(png.length / 1024).toFixed(0)} KB)`);
}
console.log(`共 ${doc.numPages} 页 → ${P.pagesDir}`);
