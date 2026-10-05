// 页图渲染：PDF → data/pages/pNNN.png（工作台对照视图用）。
// 走 pdfjs + @napi-rs/canvas 路径渲染（字形路径化，Node 无 FontFace 也可用）。
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { createCanvas, DOMMatrix, Path2D, ImageData } from "@napi-rs/canvas";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
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
const P = pathsFor(BOOK);
const PDF_PATH = P.source; // 科目源在注册表里，已随导入复制为 source.pdf
const SCALE = Number(process.argv.find((a) => a.startsWith("--scale="))?.split("=")[1] ?? 2); // 2× ≈ 144 DPI
if (!Number.isFinite(SCALE) || SCALE <= 0) {
  console.error(`非法缩放 ${SCALE}`);
  process.exit(1);
}

// 前级：手动参数的图像规范化（对比度 / 降噪 / 锐化），参数入 params.json 可复现
interface Fx { contrast: number; denoise: 0 | 1; sharpen: number }
const fx: Fx = { contrast: 100, denoise: 0, sharpen: 0, ...(existsSync(P.params) ? JSON.parse(readFileSync(P.params, "utf-8")) : {}) };

function clamp(v: number) { return v < 0 ? 0 : v > 255 ? 255 : v; }
function polish(ctx: { getImageData(x: number, y: number, w: number, h: number): ImageData; putImageData(img: ImageData, x: number, y: number): void }, w: number, h: number): void {
  const img = ctx.getImageData(0, 0, w, h);
  let d = img.data;
  if (fx.denoise === 1) { // 3×3 盒滤波
    const src = new Uint8ClampedArray(d);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        let s = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += src[((y + dy) * w + (x + dx)) * 4 + c];
        d[o + c] = s / 9;
      }
    }
  }
  if (fx.contrast !== 100) { // 线性对比度，围绕中灰
    const k = fx.contrast / 100;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = clamp((d[i] - 128) * k + 128);
      d[i + 1] = clamp((d[i + 1] - 128) * k + 128);
      d[i + 2] = clamp((d[i + 2] - 128) * k + 128);
    }
  }
  if (fx.sharpen > 0) { // 3×3 锐化卷积，量 = 百分比
    const amt = fx.sharpen / 100;
    const src = new Uint8ClampedArray(d);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const v = src[o + c] * (1 + 4 * amt)
          - (src[o - 4 + c] + src[o + 4 + c] + src[o - w * 4 + c] + src[o + w * 4 + c]) * amt;
        d[o + c] = clamp(v);
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}

const buf = readFileSync(PDF_PATH);
const doc = await pdfjsLib.getDocument({
  data: new Uint8Array(buf),
  useSystemFonts: false,
  disableFontFace: true,
  isEvalSupported: false,
  CanvasFactory: NapiCanvasFactory,
  standardFontDataUrl: path.join(ROOT, "node_modules", "pdfjs-dist", "standard_fonts") + path.sep,
}).promise;

mkdirSync(P.pagesDir, { recursive: true });
for (let p = 1; p <= doc.numPages; p++) {
  const page = await doc.getPage(p);
  const vp = page.getViewport({ scale: SCALE });
  const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx as any, viewport: vp, background: "#ffffff" } as any).promise;
  polish(ctx, canvas.width, canvas.height);
  const out = path.join(P.pagesDir, `p${String(p).padStart(3, "0")}.png`);
  const png = canvas.encodeSync("png");
  writeFileSync(out, png);
  console.log(`p${p} → ${out} (${(png.length / 1024).toFixed(0)} KB)`);
}
console.log(`共 ${doc.numPages} 页 → ${P.pagesDir}`);
