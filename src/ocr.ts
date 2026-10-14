// 本地 OCR 行为：预处理产物（页图集合）→ PP-OCRv5 意见（该书的 ocr.json，带出生证明）。
// 页图集合即预处理产物（ARCHITECTURE §1）：OCR 直接消费 pages/pNNN.png，参数指纹已绑定。
// ocr.json 是意见产物不是事实源——块图唯一写者仍是回放器；识别来源=本地时抽取器消费它换算成行。
// 行框坐标系 = 页图像素；页图像素尺寸随意见落盘，抽取器按「PDF 页宽 / 页图宽」比例换算回 PDF 点。
import { existsSync, readdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./model.ts";
import { argBook, libraryRoot, pathsFor } from "./library.ts";
import { verdictFor } from "./actions.ts";
import { loadEngine } from "./ocr-engine.ts";

const BOOK = argBook();
const P = pathsFor(BOOK);

// 行为表执法：先过预处理门（页图就绪），在途任务拒绝并行
const gate = verdictFor(BOOK, "ocr");
if (!gate.ok) {
  console.error(`拒绝识别 —— ${gate.reason}`);
  process.exit(1);
}

// 模型目录：能力配置优先；未配置而项目自带 tools/ocr 时明说来源后使用，不静默猜
function modelDir(): string {
  const cfgPath = path.join(libraryRoot(), "config.json");
  const configured = existsSync(cfgPath)
    ? JSON.parse(readFileSync(cfgPath, "utf-8"))?.ocr?.local?.modelDir
    : null;
  if (configured) {
    if (!existsSync(configured)) {
      console.error(`配置的模型目录不存在 ${configured} —— 能力配置里重新选`);
      process.exit(1);
    }
    return configured;
  }
  const fallback = path.join(ROOT, "tools", "ocr");
  if (existsSync(fallback)) {
    console.log(`未配置模型目录，使用项目自带 ${fallback}`);
    return fallback;
  }
  console.error("本地 OCR 未就绪 —— 能力配置里选模型目录（含 PP-OCRv5 ONNX 与字典）");
  process.exit(1);
}

const pages = readdirSync(P.pagesDir).filter((f) => f.endsWith(".png")).sort();
if (!pages.length) {
  console.error("页图缺失 —— 先完成预处理（确定预处理后解锁识别）");
  process.exit(1);
}

// PNG 头读像素尺寸（IHDR 在固定偏移），抽取器据此做 px→pt 比例换算
function pngSize(f: string): { w: number; h: number } {
  const b = readFileSync(path.join(P.pagesDir, f));
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

const eng = await loadEngine(modelDir());
const images: Record<string, { w: number; h: number }> = {};
const lines: { page: number; bbox: { x0: number; y0: number; x1: number; y1: number }; text: string; conf: number }[] = [];
let total = 0;
for (const [i, f] of pages.entries()) {
  const page = Number(f.slice(1, 4)); // pNNN.png
  images[String(page)] = pngSize(f);
  const { lines: ls, ms } = await eng.runPage(new Uint8Array(readFileSync(path.join(P.pagesDir, f))));
  for (const l of ls) lines.push({ page, ...l });
  total += ms;
  console.log(`  p${page}: ${ls.length} 行 · ${(ms / 1000).toFixed(1)}s`);
  console.log(`PROGRESS ${i + 1}/${pages.length}`); // 服务端采集：识别在动，不是卡死
}

const opinion = {
  createdAt: new Date().toISOString(),
  book: BOOK,
  engine: { name: "ppocrv5-mobile-onnx", ...eng.models },
  images,
  lines,
};

// 原子写：意见半途损坏不如没有意见（抽取器会明白地说缺意见，不会拿半份凑合）
const tmp = P.ocr + ".tmp";
writeFileSync(tmp, JSON.stringify(opinion), "utf-8");
renameSync(tmp, P.ocr);

console.log(`OCR 意见写入 ${P.ocr}（${pages.length} 页 ${lines.length} 行，均 ${(total / pages.length / 1000).toFixed(1)}s/页）`);
