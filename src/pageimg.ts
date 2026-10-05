// 单页渲染核心：CLI 全量渲染与预处理采样预览共用一条管线（同参数 = 同输出）。
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { createCanvas, DOMMatrix, Path2D, ImageData } from "@napi-rs/canvas";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./model.ts";

(globals() as any).DOMMatrix ??= DOMMatrix;
(globals() as any).Path2D ??= Path2D;
(globals() as any).ImageData ??= ImageData;
function globals(): Record<string, unknown> {
  return globalThis as unknown as Record<string, unknown>;
}

// pdfjs legacy 的默认 NodeCanvasFactory 硬性 require("canvas")；注入同契约的 @napi-rs/canvas 工厂
class NapiCanvasFactory {
  constructor(_: { ownerDocument?: unknown; enableHWA?: boolean } = {}) {}
  create(width: number, height: number) {
    if (width <= 0 || height <= 0) throw new Error("Invalid canvas size");
    const canvas = createCanvas(width, height);
    return { canvas, context: canvas.getContext("2d") };
  }
  reset(cc: { canvas: any }, width: number, height: number) {
    if (!cc.canvas) throw new Error("Canvas is not specified");
    cc.canvas.width = width;
    cc.canvas.height = height;
  }
  destroy(cc: { canvas: any; context: any }) {
    cc.canvas.width = 0;
    cc.canvas.height = 0;
    cc.canvas = null;
    cc.context = null;
  }
}

export interface Fx { contrast: number; denoise: 0 | 1; sharpen: number }
export const FX_DEFAULTS: Fx = { contrast: 100, denoise: 0, sharpen: 0 };

function clamp(v: number) { return v < 0 ? 0 : v > 255 ? 255 : v; }

// 前级：手动参数的图像规范化（降噪 → 对比度 → 锐化），顺序固定保证可复现
function polish(ctx: { getImageData(x: number, y: number, w: number, h: number): ImageData; putImageData(img: ImageData, x: number, y: number): void }, w: number, h: number, fx: Fx): void {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  if (fx.denoise === 1) {
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
  if (fx.contrast !== 100) {
    const k = fx.contrast / 100;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = clamp((d[i] - 128) * k + 128);
      d[i + 1] = clamp((d[i + 1] - 128) * k + 128);
      d[i + 2] = clamp((d[i + 2] - 128) * k + 128);
    }
  }
  if (fx.sharpen > 0) {
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

// 一次打开 PDF，渲染指定页号列表 → [{page, png}]（fx 逐页应用）
export async function renderPagesToBuffers(
  pdfPath: string,
  pages: number[],
  scale: number,
  fx: Fx,
): Promise<{ page: number; png: Uint8Array }[]> {
  const buf = readFileSync(pdfPath);
  const doc = await pdfjsLib.getDocument({
    data: new Uint8Array(buf),
    useSystemFonts: false,
    disableFontFace: true,
    isEvalSupported: false,
    CanvasFactory: NapiCanvasFactory,
    standardFontDataUrl: path.join(ROOT, "node_modules", "pdfjs-dist", "standard_fonts") + path.sep,
  }).promise;
  const out: { page: number; png: Uint8Array }[] = [];
  for (const p of pages) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx as any, viewport: vp, background: "#ffffff" } as any).promise;
    polish(ctx, canvas.width, canvas.height, fx);
    out.push({ page: p, png: canvas.encodeSync("png") });
  }
  return out;
}

export async function pdfPageCount(pdfPath: string): Promise<number> {
  const buf = readFileSync(pdfPath);
  const doc = await pdfjsLib.getDocument({
    data: new Uint8Array(buf),
    useSystemFonts: false,
    disableFontFace: true,
    isEvalSupported: false,
    CanvasFactory: NapiCanvasFactory,
    standardFontDataUrl: path.join(ROOT, "node_modules", "pdfjs-dist", "standard_fonts") + path.sep,
  }).promise;
  return doc.numPages;
}

export function fxHash(fx: Fx): string {
  const s = JSON.stringify([fx.contrast, fx.denoise, fx.sharpen]);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
