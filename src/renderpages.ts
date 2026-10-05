// 页图渲染 CLI：源 PDF + 前级参数 → 该书 pages/pNNN.png（全量落盘，OCR 的独立产物）。
// 渲染核心在 pageimg.ts（预处理采样共用一条管线，同参数 = 同输出）。
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { argBook, pathsFor } from "./library.ts";
import { renderPagesToBuffers, pdfPageCount, FX_DEFAULTS, type Fx } from "./pageimg.ts";

const BOOK = argBook();
const P = pathsFor(BOOK);
const PDF_PATH = P.source; // 科目源在注册表里，已随导入复制为 source.pdf
const SCALE = Number(process.argv.find((a) => a.startsWith("--scale="))?.split("=")[1] ?? 2); // 2× ≈ 144 DPI
if (!Number.isFinite(SCALE) || SCALE <= 0) {
  console.error(`非法缩放 ${SCALE}`);
  process.exit(1);
}
if (!existsSync(PDF_PATH)) {
  console.error(`源缺失 ${PDF_PATH}`);
  process.exit(1);
}
const fx: Fx = { ...FX_DEFAULTS, ...(existsSync(P.params) ? JSON.parse(readFileSync(P.params, "utf-8")) : {}) };

mkdirSync(P.pagesDir, { recursive: true });
const n = await pdfPageCount(PDF_PATH);
const pages = Array.from({ length: n }, (_, i) => i + 1);
const results = await renderPagesToBuffers(PDF_PATH, pages, SCALE, fx);
for (const r of results) {
  const out = path.join(P.pagesDir, `p${String(r.page).padStart(3, "0")}.png`);
  writeFileSync(out, r.png);
  console.log(`p${r.page} → ${out} (${(r.png.length / 1024).toFixed(0)} KB)`);
}
console.log(`共 ${n} 页 → ${P.pagesDir}（前级 ${fx.contrast}/${fx.denoise}/${fx.sharpen}）`);
