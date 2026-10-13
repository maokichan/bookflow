// 本地 OCR 引擎腿：PP-OCRv5 mobile ONNX（检测 → 方向分类 → 裁剪 → 识别），onnxruntime-node CPU。
// 后处理全部纯 JS、确定可复现：检测概率图 → 阈值化 → 膨胀 → 连通域 → 轴对齐框 + unclip 外扩；
// 识别 CTC 贪心解码配字典。行框坐标系 = 传入页图原始像素（调用方负责换算回 PDF 点）。
// 意见产物落盘归 src/ocr.ts，引擎只管认字。
import { readdirSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { InferenceSession, Tensor } from "onnxruntime-node";

// ---------- 参数（MVP 定值；要调参走这里的常量，不散落） ----------
const DET_SIDE = 960; // 检测输入长边上限（PaddleOCR 默认口径）
const DET_THRESH = 0.3; // 概率图二值化
const BOX_THRESH = 0.5; // 框内平均概率门槛（取偏低值换召回，第二意见宁可多看）
const UNCLIP = 1.6; // 框外扩比例（DB unclip）
const CLS_THRESH = 0.9; // 方向分类判 180° 的置信门槛
const REC_MAX_W = 640; // 识别输入最大宽（超长行压入，长行精度换吞吐）

export interface OcrLine { bbox: { x0: number; y0: number; x1: number; y1: number }; text: string; conf: number }

function pickModel(dir: string, re: RegExp, what: string, required: boolean): string | null {
  const hit = readdirSync(dir).find((f) => re.test(f.toLowerCase()));
  if (!hit) {
    if (required) throw new Error(`模型目录缺 ${what}（${dir} 里找不到匹配 ${re} 的文件）`);
    return null;
  }
  return path.join(dir, hit);
}

export interface OcrEngine {
  runPage: (png: Uint8Array) => Promise<{ lines: OcrLine[]; ms: number }>;
  models: { dir: string; det: string; rec: string; cls: string | null; dict: string };
}

export async function loadEngine(modelDir: string): Promise<OcrEngine> {
  const detPath = pickModel(modelDir, /det.*\.onnx$/, "检测模型", true)!;
  const recPath = pickModel(modelDir, /rec.*\.onnx$/, "识别模型", true)!;
  const clsPath = pickModel(modelDir, /cls.*\.onnx$/, "方向分类模型", false);
  const dictPath = pickModel(modelDir, /dict.*\.txt$/, "字典", true)!;
  const opts = { executionProviders: ["cpu"], graphOptimizationLevel: "all" } as const;
  const [det, rec, cls] = await Promise.all([
    InferenceSession.create(detPath, opts),
    InferenceSession.create(recPath, opts),
    clsPath ? InferenceSession.create(clsPath, opts) : Promise.resolve(null),
  ]);
  const { readFileSync } = await import("node:fs");
  const dict = readFileSync(dictPath!, "utf-8").split("\n").map((s) => s.replace(/\r$/, ""));
  if (dict.length && dict[dict.length - 1] === "") dict.pop(); // 尾随换行会顶掉空格 token 的位置

  // 解码 CTC：字典自适应对齐输出维度（blank 占 0；PP-OCR 惯例在字典尾部补半角空格）
  let chars: string[] | null = null;
  function buildChars(c: number): string[] {
    const list = ["", ...dict];
    if (c === list.length + 1) list.push(" ");
    else if (c !== list.length)
      console.warn(`字典 ${dict.length} 行与识别输出维度 ${c} 不符 —— 多余索引将产出空字符`);
    return list;
  }

  // ---------- 图像进张量的小件 ----------
  async function rawRGB(png: Uint8Array): Promise<{ data: Buffer; w: number; h: number }> {
    const { data, info } = await sharp(Buffer.from(png)).flatten({ background: "#ffffff" }).raw().toBuffer({ resolveWithObject: true });
    return { data, w: info.width, h: info.height };
  }
  function chw(rgb: Buffer, w: number, h: number, mean: number[], std: number[], ow: number, oh: number): Float32Array {
    // RGB HWC → 归一化 CHW；目标尺寸 ow×oh（不足补 0，即补均值灰）
    const out = new Float32Array(3 * ow * oh);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 3;
        const o = y * ow + x;
        out[o] = (rgb[i] / 255 - mean[0]) / std[0];
        out[ow * oh + o] = (rgb[i + 1] / 255 - mean[1]) / std[1];
        out[2 * ow * oh + o] = (rgb[i + 2] / 255 - mean[2]) / std[2];
      }
    }
    return out;
  }
  const IMG_MEAN = [0.485, 0.456, 0.406], IMG_STD = [0.229, 0.224, 0.225];
  const HALF = [0.5, 0.5, 0.5], HALF_STD = [0.5, 0.5, 0.5];

  async function resizeRGB(rgb: Buffer, w: number, h: number, tw: number, th: number): Promise<Buffer> {
    return sharp(rgb, { raw: { width: w, height: h, channels: 3 } })
      .resize(tw, th, { fit: "fill" }).raw().toBuffer();
  }

  // ---------- 检测：概率图 → 行框（原图像素坐标，按 y 再 x 排序） ----------
  async function detect(rgb: Buffer, w: number, h: number): Promise<{ x0: number; y0: number; x1: number; y1: number }[]> {
    const ratio = Math.min(1, DET_SIDE / Math.max(w, h));
    const rw = Math.max(32, Math.ceil((w * ratio) / 32) * 32);
    const rh = Math.max(32, Math.ceil((h * ratio) / 32) * 32);
    const small = await resizeRGB(rgb, w, h, rw, rh);
    const input = chw(small, rw, rh, IMG_MEAN, IMG_STD, rw, rh);
    const out = await det!.run({ [det!.inputNames[0]]: new Tensor("float32", input, [1, 3, rh, rw]) });
    const prob = out[det!.outputNames[0]].data as Float32Array;
    const pw = out[det!.outputNames[0]].dims[3] as number, ph = out[det!.outputNames[0]].dims[2] as number;

    // 二值化 + 3×3 膨胀一轮（DB 输出偏瘦，膨胀一轮把笔画连成行）
    const bin = new Uint8Array(pw * ph);
    for (let i = 0; i < bin.length; i++) bin[i] = prob[i] > DET_THRESH ? 1 : 0;
    const dil = new Uint8Array(pw * ph);
    for (let y = 0; y < ph; y++) {
      for (let x = 0; x < pw; x++) {
        if (!bin[y * pw + x]) continue;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy; if (yy < 0 || yy >= ph) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx; if (xx < 0 || xx >= pw) continue;
            dil[yy * pw + xx] = 1;
          }
        }
      }
    }
    // 连通域（8 邻接 BFS）→ 轴对齐框 + 框内平均概率
    const seen = new Uint8Array(pw * ph);
    const stack = new Int32Array(pw * ph);
    const boxes: { x0: number; y0: number; x1: number; y1: number; score: number }[] = [];
    for (let start = 0; start < dil.length; start++) {
      if (!dil[start] || seen[start]) continue;
      let sp = 0;
      stack[sp++] = start;
      seen[start] = 1;
      let x0 = pw, y0 = ph, x1 = 0, y1 = 0, sum = 0, n = 0;
      while (sp > 0) {
        const p = stack[--sp];
        const py = (p / pw) | 0, px = p % pw;
        if (px < x0) x0 = px; if (px > x1) x1 = px;
        if (py < y0) y0 = py; if (py > y1) y1 = py;
        sum += prob[p]; n++;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = py + dy; if (yy < 0 || yy >= ph) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = px + dx; if (xx < 0 || xx >= pw) continue;
            const q = yy * pw + xx;
            if (dil[q] && !seen[q]) { seen[q] = 1; stack[sp++] = q; }
          }
        }
      }
      if (n === 0 || sum / n < BOX_THRESH) continue;
      // unclip：矩形按 周长-面积 口径外扩（Paddle 的 clipper delta 近似）
      const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      const off = (bw * bh * UNCLIP) / (2 * (bw + bh));
      // 映射回原图像素（检测图可能被补边，按原比例回投并裁到界内）
      const sx = w / pw, sy = h / ph;
      const bx0 = Math.max(0, (x0 - off) * sx), by0 = Math.max(0, (y0 - off) * sy);
      const bx1 = Math.min(w, (x1 + 1 + off) * sx), by1 = Math.min(h, (y1 + 1 + off) * sy);
      if (bx1 - bx0 < 4 || by1 - by0 < 4) continue;
      boxes.push({ x0: bx0, y0: by0, x1: bx1, y1: by1, score: sum / n });
    }
    return boxes;
  }

  // ---------- 方向分类：0° / 180° ----------
  async function isUpsideDown(rgb: Buffer, w: number, h: number): Promise<boolean> {
    if (!cls) return false;
    const th = 48, twMax = 192;
    const tw = Math.min(twMax, Math.max(1, Math.round((w / h) * th)));
    const small = await resizeRGB(rgb, w, h, tw, th);
    const padded = Buffer.concat([small, Buffer.alloc((twMax - tw) * th * 3)]);
    const input = chw(padded, twMax, th, HALF, HALF_STD, twMax, th);
    const out = await cls.run({ [cls.inputNames[0]]: new Tensor("float32", input, [1, 3, th, twMax]) });
    const logits = out[cls.outputNames[0]].data as Float32Array;
    const max0 = Math.max(logits[0], logits[1]);
    const exp0 = Math.exp(logits[0] - max0), exp1 = Math.exp(logits[1] - max0);
    const p180 = exp1 / (exp0 + exp1);
    return p180 > CLS_THRESH;
  }

  // ---------- 识别：单行裁剪 → 文本 + 置信 ----------
  async function recognize(rgb: Buffer, w: number, h: number): Promise<{ text: string; conf: number }> {
    const th = 48;
    const tw = Math.max(16, Math.min(REC_MAX_W, Math.round((w / h) * th)));
    const small = await resizeRGB(rgb, w, h, tw, th);
    const input = chw(small, tw, th, HALF, HALF_STD, tw, th);
    const out = await rec.run({ [rec.inputNames[0]]: new Tensor("float32", input, [1, 3, th, tw]) });
    const logits = out[rec.outputNames[0]].data as Float32Array;
    const dims = out[rec.outputNames[0]].dims as number[]; // [1, T, C]
    const T = dims[1], C = dims[2];
    if (!chars) chars = buildChars(C);
    let text = "", sum = 0, n = 0, last = 0;
    for (let t = 0; t < T; t++) {
      let best = 0, bestP = -1;
      for (let c = 0; c < C; c++) {
        const p = logits[t * C + c];
        if (p > bestP) { bestP = p; best = c; }
      }
      if (best !== 0 && best !== last) {
        text += chars[best] ?? "";
        sum += bestP; n++;
      }
      last = best;
    }
    return { text: text.trim(), conf: n ? sum / n : 0 };
  }

  async function runPage(png: Uint8Array): Promise<{ lines: OcrLine[]; ms: number }> {
    const t0 = Date.now();
    const { data: buf, w, h } = await rawRGB(png);
    const boxes = await detect(buf, w, h);
    const lines: OcrLine[] = [];
    for (const b of boxes) {
      const x0 = Math.floor(b.x0), y0 = Math.floor(b.y0);
      const cw = Math.min(w, Math.ceil(b.x1)) - x0, chh = Math.min(h, Math.ceil(b.y1)) - y0;
      if (cw < 4 || chh < 4) continue;
      const crop = await sharp(buf, { raw: { width: w, height: h, channels: 3 } })
        .extract({ left: x0, top: y0, width: cw, height: chh }).raw().toBuffer();
      const up = await isUpsideDown(crop, cw, chh);
      const final = up ? await sharp(crop, { raw: { width: cw, height: chh, channels: 3 } }).rotate(180).raw().toBuffer() : crop;
      const { text, conf } = await recognize(final, cw, chh);
      if (!text) continue;
      lines.push({ bbox: { x0, y0, x1: x0 + cw, y1: y0 + chh }, text, conf });
    }
    lines.sort((a, b) => ((a.bbox.y0 + a.bbox.y1) / 2) - ((b.bbox.y0 + b.bbox.y1) / 2) || a.bbox.x0 - b.bbox.x0);
    return { lines, ms: Date.now() - t0 };
  }

  return {
    runPage,
    models: { dir: modelDir, det: path.basename(detPath), rec: path.basename(recPath),
      cls: clsPath ? path.basename(clsPath) : null, dict: path.basename(dictPath!) },
  };
}
