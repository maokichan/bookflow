// 工作台导出器：块图 + 页图 → workbench/workbench.html（单文件，数据内联，页图相对路径）。
// 块图每前进一步都可重新导出；工作台自身无持久状态（裁决走日志）。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { PATHS, loadGraph } from "./model.ts";

const g = loadGraph();
if (!existsSync(PATHS.pagesDir)) {
  console.error("页图目录不存在 —— 先运行 npm run render");
  process.exit(1);
}
const tpl = readFileSync(path.join(import.meta.dirname, "workbench-template.html"), "utf-8");
const payload = JSON.stringify({
  title: g.title,
  source: g.source,
  pages: g.pages,
  blocks: g.blocks.map((b) => ({
    id: b.id, page: b.page, bbox: b.bbox, type: b.type, state: b.state, text: b.text,
  })),
}).replace(/<\/script>/gi, "<\\/script>");

const html = tpl.replace("/*__DATA__*/null;", "var DATA = " + payload + ";");
mkdirSync(PATHS.workbenchDir, { recursive: true });
const out = path.join(PATHS.workbenchDir, "workbench.html");
writeFileSync(out, html, "utf-8");
console.log(`工作台 → ${out}（${(html.length / 1024).toFixed(0)} KB，块 ${g.blocks.length}，页 ${g.pages.length}）`);
console.log(`浏览器打开 file://${out.replaceAll("\\", "/")} ，裁决后把日志放入 inbox/ 跑 npm run replay`);
