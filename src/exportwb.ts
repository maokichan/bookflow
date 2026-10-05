// 工作台导出器：块图 + 页图 → 该书目录下 workbench.html（单文件，数据内联，页图相对路径）。
// 块图每前进一步都可重新导出；工作台自身无持久状态（裁决走日志）。
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { loadGraph } from "./model.ts";
import { argBook, pathsFor } from "./library.ts";

const P = pathsFor(argBook());
const g = loadGraph(P.graph);
if (!existsSync(P.pagesDir)) {
  console.error("页图目录不存在 —— 先对该书运行渲染");
  process.exit(1);
}
const tpl = readFileSync(path.join(import.meta.dirname, "workbench-template.html"), "utf-8");
const payload = JSON.stringify({
  title: g.title,
  source: g.source,
  pages: g.pages,
  blocks: g.blocks.map((b) => ({
    id: b.id, page: b.page, bbox: b.bbox, type: b.type, state: b.state, text: b.text,
    level: b.level,
  })),
}).replace(/<\/script>/gi, "<\\/script>");

// 页图与工作台同在书目录下，相对路径即 pages/
const html = tpl.replace("/*__DATA__*/null;", `var PAGES_BASE = "pages/";\nvar DATA = ` + payload + ";");
writeFileSync(P.workbench, html, "utf-8");
console.log(`工作台 → ${P.workbench}（${(html.length / 1024).toFixed(0)} KB，块 ${g.blocks.length}，页 ${g.pages.length}）`);
console.log(`书架里点开，或浏览器打开 file://${P.workbench.replaceAll("\\", "/")}；裁决日志放入该书 inbox/ 后回放`);
