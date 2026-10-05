// 单页渲染核心：CLI 全量渲染与预处理采样预览共用一条管线（同参数 = 同输出）。
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { createCanvas, DOMMatrix, Path2D, ImageData } from "@napi-rs/canvas";
import { readFileSync } from "node:fs";
import sharp from "sharp";
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

export interface Fx { contrast: number; denoise: number; sharpen: number } // denoise 0/1/2 = 关/中值3/中值5
export const FX_DEFAULTS: Fx = { contrast: 100, denoise: 0, sharpen: 0 };

// 前级：成熟图像原语（sharp/libvips），顺序固定保证可复现：降噪(中值) → 对比度(围绕中灰线性) → 锐化
async function loadDoc(pdfPath: string) {
  const buf = readFileSync(pdfPath);
  return pdfjsLib.getDocument({
    data: new Uint8Array(buf),
    useSystemFonts: false,
    disableFontFace: true,
    isEvalSupported: false,
    CanvasFactory: NapiCanvasFactory,
    standardFontDataUrl: path.join(ROOT, "node_modules", "pdfjs-dist", "standard_fonts") + path.sep,
  }).promise;
}

// 书籍是否自带文本层（识别来源选择的依据）
export async function hasTextLayer(pdfPath: string): Promise<boolean> {
  const doc = await loadDoc(pdfPath);
  const page = await doc.getPage(1);
  const tc = await page.getTextContent();
  const chars = tc.items.reduce((s: number, it: any) => s + (it.str?.length ?? 0), 0);
  return chars > 20;
}

export async function polishBuffer(png: Uint8Array, fx: Fx): Promise<Uint8Array> {
  let p = sharp(Buffer.from(png));
  if (fx.denoise > 0) p = p.median(fx.denoise === 2 ? 5 : 3);
  if (fx.contrast !== 100) {
    const k = fx.contrast / 100;
    p = p.linear(k, 128 * (1 - k));
  }
  if (fx.sharpen > 0) p = p.sharpen({ sigma: 0.5 + fx.sharpen / 100 });
  const out = await p.png().toBuffer();
  return new Uint8Array(out);
}

// 一次打开 PDF，渲染指定页号列表 → [{page, png}]（fx 逐页应用）
export async function renderPagesToBuffers(
  pdfPath: string,
  pages: number[],
  scale: number,
  fx: Fx,
): Promise<{ page: number; png: Uint8Array }[]> {
  const doc = await loadDoc(pdfPath);
  const out: { page: number; png: Uint8Array }[] = [];
  for (const p of pages) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx as any, viewport: vp, background: "#ffffff" } as any).promise;
    const raw = canvas.encodeSync("png");
    out.push({ page: p, png: await polishBuffer(raw, fx) });
  }
  return out;
}

export async function pdfPageCount(pdfPath: string): Promise<number> {
  const doc = await loadDoc(pdfPath);
  return doc.numPages;
}

export function fxHash(fx: Fx): string {
  const s = JSON.stringify([fx.contrast, fx.denoise, fx.sharpen]);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
