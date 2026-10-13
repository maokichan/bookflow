// S0+S1（MVP 合并跑）：文本层 PDF → 行 → 分型 → 段落重组 → 块图。
// 分型启发式移植自 kookit getTextFromPDFPage（字号众数定正文、y 间距切段），
// 并补：页眉页脚跨页重复聚类（页面附着块）、大字号短行（结构块）。
// 科目由注册表提供（书架导入时登记源与书名），工具按 --book 寻址。
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { ROOT, saveGraph, readGraphVersion, type Block, type BlockGraph, type BlockType } from "./model.ts";
import { argBook, getBook, pathsFor } from "./library.ts";
import { verdictFor } from "./actions.ts";

// 科目由注册表提供（书架导入时登记源与书名），工具只按书号干活
const BOOK = argBook();
const meta = getBook(BOOK);
const PDF_PATH = pathsFor(BOOK).source;
const TITLE = meta.title;

// 行为表执法（src/actions.ts）：块图已含人工成果时重抽 = 毁裁决，拒绝；--force 是显式越权通道
const gate = verdictFor(BOOK, "extract");
if (!gate.ok && !process.argv.includes("--force")) {
  console.error(`拒绝抽取 —— ${gate.reason}`);
  process.exit(1);
}

// ---------- pdfjs Node 全局 ----------
import { DOMMatrix, Path2D, ImageData } from "@napi-rs/canvas";
(globals() as any).DOMMatrix ??= DOMMatrix;
(globals() as any).Path2D ??= Path2D;
(globals() as any).ImageData ??= ImageData;
function globals(): Record<string, unknown> {
  return globalThis as unknown as Record<string, unknown>;
}

// ---------- 工具 ----------
const CJK = /[\u3000-\u9fff\uf900-\ufaff\u3040-\u30ff]/;
const isCJK = (s: string) => CJK.test(s);
const mode = (arr: number[], round = 0.5) => {
  const m = new Map<number, number>();
  for (const v of arr) {
    const k = Math.round(v / round) * round;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  let best = 0, bestN = -1;
  for (const [k, n] of m) if (n > bestN) { best = k; bestN = n; }
  return best;
};

interface Line {
  page: number;
  x0: number; x1: number;
  top: number; bottom: number; // 左上原点
  fs: number;
  text: string;
}

// ---------- 主流程 ----------
const buf = readFileSync(PDF_PATH);
const doc = await pdfjsLib.getDocument({
  data: new Uint8Array(buf),
  useSystemFonts: false,
  disableFontFace: true, // Node 无 FontFace API：字形走路径渲染
  isEvalSupported: false,
  standardFontDataUrl: path.join(ROOT, "node_modules", "pdfjs-dist", "standard_fonts") + path.sep,
}).promise;

console.log(`打开 ${path.basename(PDF_PATH)}，${doc.numPages} 页`);

const pages: { w: number; h: number }[] = [];
const lines: Line[] = [];

// 页面尺寸先于行源采集（两种行源都要用：OCR 行的 px→pt 换算靠它）
for (let p = 1; p <= doc.numPages; p++) {
  const page = await doc.getPage(p);
  const vp = page.getViewport({ scale: 1 });
  pages.push({ w: vp.width, h: vp.height });
}

// ---------- 行源：识别来源决定行从哪来（自带文本层 / 本地 OCR 意见），下游分型与重组不感知差异 ----------
const paramsPath = pathsFor(BOOK).params;
const source_ = existsSync(paramsPath)
  ? (JSON.parse(readFileSync(paramsPath, "utf-8")).ocr?.engine ?? "textlayer")
  : "textlayer";

if (source_ === "local") {
  // OCR 意见 → 行。坐标换算按「PDF 页宽 / 页图像素宽」比例（与渲染 scale 无关，不怕参数漂移）；
  // 字号用行高代替：分型只看行间相对比例（结构/注释判据都是 baseFs 的倍数），够用
  const opPath = pathsFor(BOOK).ocr;
  if (!existsSync(opPath)) {
    console.error("本地 OCR 意见缺失 —— 先跑识别（书架点识别，或 npm run ocr -- --book <id>）");
    process.exit(1);
  }
  const op = JSON.parse(readFileSync(opPath, "utf-8"));
  if (op.book !== BOOK) {
    console.error(`OCR 意见投错书（意见属 ${op.book}）—— 回书架重跑识别`);
    process.exit(1);
  }
  for (const l of op.lines) {
    const img = op.images[String(l.page)];
    const dim = pages[l.page - 1];
    if (!img || !dim || !l.text) continue;
    const k = dim.w / img.w;
    lines.push({
      page: l.page,
      x0: l.bbox.x0 * k, x1: l.bbox.x1 * k,
      top: l.bbox.y0 * k, bottom: l.bbox.y1 * k,
      fs: (l.bbox.y1 - l.bbox.y0) * k,
      text: l.text,
    });
  }
  console.log(`识别来源：本地 OCR 意见 —— ${lines.length} 行（${op.engine?.name ?? "?"}）`);
} else {
for (let p = 1; p <= doc.numPages; p++) {
  const page = await doc.getPage(p);
  const tc = await page.getTextContent();
  type It = { str: string; tr: number[]; w: number; h: number; eol: boolean };
  const items = (tc.items as any[])
    .filter((it) => typeof it.str === "string" && it.str.trim() !== "" && Array.isArray(it.transform))
    .map((it) => ({ str: it.str as string, tr: it.transform as number[], w: it.width as number, h: it.height as number, eol: !!it.hasEOL }));

  // 按基线 y 聚成行（容差 4.5pt：吸收上标脚注标记，其基线抬高约 0.35em）
  const rows = new Map<number, It[]>();
  for (const it of items) {
    const y = it.tr[5];
    let key: number | undefined;
    for (const k of rows.keys()) if (Math.abs(k - y) <= 4.5) { key = k; break; }
    if (key === undefined) { key = y; rows.set(key, []); }
    rows.get(key)!.push(it);
  }

  let droppedMarkers = 0;
  for (const [baseY, arr] of rows) {
    arr.sort((a, b) => a.tr[4] - b.tr[4]);
    // 行字号按字符数加权取众数：防个别小字形（上标标记）带偏主导字号
    const fsOf = () => {
      const m = new Map<number, number>();
      for (const it of arr) {
        const s = Math.abs(it.tr[3]) || it.h;
        m.set(s, (m.get(s) ?? 0) + it.str.length);
      }
      let best = arr[0]?.h || 10, bestN = -1;
      for (const [k, n] of m) if (n > bestN) { best = k; bestN = n; }
      return best;
    };
    const fs = fsOf();
    let text = "";
    let prevEnd: number | null = null;
    for (const it of arr) {
      // 纯数字上标标记（脚注锚点字形）：并入行位置但不进文本，计数上报
      if (Math.abs(it.tr[3]) < fs * 0.65 && /^\d{1,3}$/.test(it.str.trim())) { droppedMarkers++; continue; }
      if (prevEnd !== null) {
        const gap = it.tr[4] - prevEnd;
        if (gap > fs * 0.1 && !(isCJK(text.slice(-1)) && isCJK(it.str[0]))) text += " ";
      }
      text += it.str;
      prevEnd = it.tr[4] + it.w;
    }
    text = text.replace(/\s+$/, "");
    if (!text) continue;
    lines.push({
      page: p,
      x0: Math.min(...arr.map((it) => it.tr[4])),
      x1: Math.max(...arr.map((it) => it.tr[4] + it.w)),
      top: pages[p - 1].h - baseY - fs * 0.95,
      bottom: pages[p - 1].h - baseY + fs * 0.30,
      fs, text,
    });
  }
  if (droppedMarkers) console.log(`  p${p}: 丢弃上标锚点标记 ${droppedMarkers} 个（脚注编号字形，正文不含）`);
}
}

// ---------- 分型 ----------
// 页面附着块：顶部区跨页重复（去数字规范化；MVP 阈值 ≥2 页，短书可触发）+ 底部区纯数字/页码样式
const norm = (s: string) => s.replace(/[\d\s\u2000-\u206f！？。，、·—–-]/g, "");
const topZone = (l: Line, h: number) => l.top < h * 0.13;
const botZone = (l: Line, h: number) => l.bottom > h * 0.88;

const headerCount = new Map<string, Set<number>>();
for (const l of lines) {
  const h = pages[l.page - 1].h;
  if (topZone(l, h)) {
    const k = norm(l.text);
    if (k.length >= 2) {
      if (!headerCount.has(k)) headerCount.set(k, new Set());
      headerCount.get(k)!.add(l.page);
    }
  }
}
const isHeader = (l: Line, h: number) =>
  topZone(l, h) && (headerCount.get(norm(l.text))?.size ?? 0) >= 2;
const isFooter = (l: Line, h: number) =>
  botZone(l, h) && /^[\d\s\-–—.、·第页]*\d[\d\s\-–—.、·第页]*$/.test(l.text);

// 书眉排页脚的书（真实科目：鲍德里亚）：底部区跨页重复 → 附着块（顶部区聚类的镜像）
const botRepeat = new Map<string, Set<number>>();
for (const l of lines) {
  const h = pages[l.page - 1].h;
  if (botZone(l, h) && !digitOnly0(l.text)) {
    const k = norm(l.text);
    if (k.length >= 2) {
      if (!botRepeat.has(k)) botRepeat.set(k, new Set());
      botRepeat.get(k)!.add(l.page);
    }
  }
}
const isBotRunningHead = (l: Line, h: number) =>
  botZone(l, h) && (botRepeat.get(norm(l.text))?.size ?? 0) >= 2;
function digitOnly0(s: string) { return /^[\d\s\-–—.、·第页]*$/.test(s); }

// 正文基准字号：非附着行字号众数
const baseFs = mode(lines.filter((l) => !isFooter(l, pages[l.page - 1].h)).map((l) => l.fs), 0.5);
console.log(`基准字号 ${baseFs}pt；行数 ${lines.length}`);

// 行 → 分型标记
type Tagged = { line: Line; kind: "furniture" | "structure" | "annotation" | "flow" };
const digitOnly = (s: string) => /^[\d\s\-–—.、·第页]*$/.test(s);
const kinds: Tagged["kind"][] = lines.map((l) => {
  const h = pages[l.page - 1].h;
  if (isHeader(l, h) || isFooter(l, h) || isBotRunningHead(l, h)) return "furniture";
  if (l.fs >= baseFs * 1.25 && l.text.length <= 40) return "structure";
  return "flow";
});
// 锚定支流块（注释体）：空域信号优先于字号——「正文最后一行之下」才是脚注区
// （引文体字号虽小但其下仍有正文，实测真实书三层字号 9.5/8.5/7.0 + 书眉页码 6.5）。
// 候选 = 底部四分之一区 + ①-⑳ 注号起手或 fs≤0.92×基准；续行（小字、行距 < pitch×1.4）跟随。
// 锚点配对留给人工作业 #1（架构 §2：未配对注释=显式待办）。
const botQuarter = (l: Line, h: number) => l.bottom > h * 0.72;
for (let p = 1; p <= pages.length; p++) {
  const h = pages[p - 1].h;
  const idxs = lines.map((l, i) => ({ l, i })).filter(({ l }) => l.page === p).sort((a, b) => a.l.top - b.l.top);
  if (!idxs.length) continue;
  let lastFlow = -1;
  for (let j = 0; j < idxs.length; j++)
    if (kinds[idxs[j].i] === "flow" && idxs[j].l.fs > baseFs * 0.92) lastFlow = j;
  if (lastFlow < 0) continue;
  const pitch = mode(idxs.slice(1).map(({ l }, i) => l.top - idxs[i].l.top), 0.5) || 14;
  let prevAnn = false;
  for (let j = lastFlow + 1; j < idxs.length; j++) {
    const { l, i } = idxs[j];
    if (kinds[i] !== "flow") { prevAnn = false; continue; }
    const isFoot = botQuarter(l, h) && (/^[\u2460-\u24FF]/.test(l.text) || l.fs <= baseFs * 0.92);
    const isCont = prevAnn && l.fs <= baseFs * 0.92 && l.top - idxs[j - 1].l.top < pitch * 1.4;
    if (isFoot || isCont) { kinds[i] = "annotation"; prevAnn = true; } else { prevAnn = false; }
  }
}
const tagged: Tagged[] = lines.map((l, i) => ({ line: l, kind: kinds[i] }));

// ---------- 段落重组（流转）+ 块组装 ----------
// 切段双信号：行距突增（> pitch×1.3）或首行缩进（CJK 书惯例 2em）。
// 实测本测试书：段内 18.2 / 段间 24.5，比值 1.35 —— 阈值 1.5 永远切不开，1.3 才对。
const leftEdge = mode(tagged.filter((t) => t.kind === "flow").map((t) => t.line.x0), 1);
const isIndent = (l: Line) => l.x0 > leftEdge + baseFs * 0.8;
const joined: { page: number; texts: string[]; kind: BlockType; lines: Line[] }[] = [];
for (let p = 1; p <= pages.length; p++) {
  const rows = tagged.filter((t) => t.line.page === p);
  const flows = rows.filter((r) => r.kind === "flow");
  const pitch = mode(flows.slice(1).map((r, i) => r.line.top - flows[i].line.top), 0.5) || 14;
  let cur: Tagged[] = [];
  const flush = () => {
    if (cur.length) { joined.push({ page: p, texts: cur.map((c) => c.line.text), kind: "flow", lines: cur.map((c) => c.line) }); cur = []; }
  };
  for (let i = 0; i < flows.length; i++) {
    if (i === 0) { cur.push(flows[i]); continue; }
    const gap = flows[i].line.top - flows[i - 1].line.top;
    if (gap > pitch * 1.3 || isIndent(flows[i].line)) flush();
    cur.push(flows[i]);
  }
  flush();
  // structure 行独立成块（同页相邻同字号行合并）
  const structs = rows.filter((r) => r.kind === "structure");
  let sCur: Tagged[] = [];
  const sFlush = () => {
    if (sCur.length) { joined.push({ page: p, texts: sCur.map((c) => c.line.text), kind: "structure", lines: sCur.map((c) => c.line) }); sCur = []; }
  };
  for (let i = 0; i < structs.length; i++) {
    if (i === 0) { sCur.push(structs[i]); continue; }
    const gap = structs[i].line.top - structs[i - 1].line.top;
    if (gap > structs[i].line.fs * 1.8) sFlush();
    sCur.push(structs[i]);
  }
  sFlush();
  // 附着行逐行成块；注释行相邻合并（脚注体常折多行，行距 < pitch×1.3）
  for (const r of rows.filter((r) => r.kind === "furniture")) {
    joined.push({ page: p, texts: [r.line.text], kind: "furniture", lines: [r.line] });
  }
  let aCur: Tagged[] = [];
  const aFlush = () => {
    if (aCur.length) { joined.push({ page: p, texts: aCur.map((c) => c.line.text), kind: "annotation", lines: aCur.map((c) => c.line) }); aCur = []; }
  };
  for (const r of rows.filter((r) => r.kind === "annotation")) {
    if (aCur.length && r.line.top - aCur[aCur.length - 1].line.top > pitch * 1.3) aFlush();
    aCur.push(r);
  }
  aFlush();
}
// 行序按页面出现顺序（上面 per-page push 顺序 = y 序？flows/structs 混排需重排）
joined.sort((a, b) =>
  a.page - b.page ||
  Math.min(...a.lines.map((l) => l.top)) - Math.min(...b.lines.map((l) => l.top)));

// 行文本拼接（段内行合并：CJK 直接接，拉丁加空格，行尾连字符去拼）
const joinLines = (texts: string[]) => {
  let out = "";
  for (const t of texts) {
    if (!out) { out = t; continue; }
    if (out.endsWith("-") && !isCJK(t[0])) out = out.slice(0, -1) + t;
    else if (isCJK(out.slice(-1)) || isCJK(t[0])) out += t;
    else out += " " + t;
  }
  return out;
};

// ===== S2 清洗槽位（机械规则、确定可复现）：嵌入 OCR 层噪声归一 =====
// 只处理机械可判定的失真：伪空格（两端排字距被 OCR 当成空格）、被拆散的数字、
// CJK 标点前空格、开括号后空格。拉丁-拉丁空格不动（无法机械区分断词），® 噪音留给分歧仲裁。
const S2_CJK = "\\u4e00-\\u9fff\\u3400-\\u4dbf";
const S2_CJK_PUNCT = "，。、；：？！）》」』】〉";
const S2_OPEN_PUNCT = "（《「『【〈";
let cleanCount = 0;
let cleanChars = 0;
function cleanText(t: string): string {
  const c = t
    .replace(/[\u3000\u00a0]/g, " ")
    .replace(/ {2,}/g, " ")
    .replace(new RegExp(`(?<=[${S2_CJK}]) (?=[${S2_CJK}])`, "g"), "")
    .replace(/(?<=\d) (?=\d)/g, "")
    .replace(new RegExp(` (?=[${S2_CJK_PUNCT}])`, "g"), "")
    .replace(new RegExp(`(?<=[${S2_OPEN_PUNCT}]) `, "g"), "")
    .trim();
  if (c !== t) { cleanCount++; cleanChars += t.length - c.length; }
  return c;
}

const blocks: Block[] = [];
let seqByPage = new Map<number, number>();
for (const j of joined) {
  const texts: string[] = j.kind === "flow" ? splitParagraph(j) : [joinLines(j.texts)];
  for (const raw of texts) {
    const text = cleanText(raw);
    const seq = (seqByPage.get(j.page) ?? 0) + 1;
    seqByPage.set(j.page, seq);
    const ls = j.lines;
    blocks.push({
      id: `p${String(j.page).padStart(2, "0")}-b${String(seq).padStart(3, "0")}`,
      page: j.page,
      bbox: {
        x0: Math.min(...ls.map((l) => l.x0)),
        y0: Math.min(...ls.map((l) => l.top)),
        x1: Math.max(...ls.map((l) => l.x1)),
        y1: Math.max(...ls.map((l) => l.bottom)),
      },
      type: j.kind,
      state: "typed",
      text,
      bold: false,
      findings: [],
      history: [{ ts: new Date().toISOString(), action: "typed", by: "machine:extract" }],
    });
  }
}

// splitParagraph：把单页 flow 聚合行按“段”拆开 —— 简化：聚合时已按间隙切，
// joined 的 flow 条目天然是一段（texts 单元素数组包装），此函数保留以防将来聚合粒度变化
function splitParagraph(j: { texts: string[]; lines: Line[] }): string[] {
  return [joinLines(j.texts)];
}

// 注意力框（预处理阶段定义的页眉/页脚带）：带内块归附着块，不进待校队列
const regionsFile = path.join(pathsFor(BOOK).dir, "regions.json");
if (existsSync(regionsFile)) {
  const bands = JSON.parse(readFileSync(regionsFile, "utf-8")).bands ?? [];
  let hit = 0;
  for (const b of blocks) {
    const h = pages[b.page - 1]?.h ?? 0;
    if (!h) continue;
    const yc = (b.bbox.y0 + b.bbox.y1) / 2 / h;
    if (bands.some((r: any) => yc >= r.y0 && yc <= r.y1)) { b.type = "furniture"; hit++; }
  }
  if (hit) console.log(`注意力框：${hit} 块归入附着`);
}

const graph: BlockGraph = {
  version: 0,
  source: path.relative(ROOT, PDF_PATH),
  title: TITLE,
  createdAt: new Date().toISOString(),
  pages,
  blocks,
};

const P = pathsFor(BOOK);
mkdirSync(path.dirname(P.graph), { recursive: true });
graph.version = readGraphVersion(P.graph) ?? -1; // 版本单调：saveGraph 统一 +1 —— 重抽不回零，陈旧工作台靠版本对账识破
saveGraph(P.graph, graph); // 原子写：块图里沉淀着人的裁决，坏写不落盘

const byType = blocks.reduce<Record<string, number>>((m, b) => ((m[b.type] = (m[b.type] ?? 0) + 1), m), {});
console.log(`块图写入 ${P.graph}`);
console.log(`共 ${blocks.length} 块：`, byType);
console.log(`S2 清洗：${cleanCount} 块、删 ${cleanChars} 字符`);
