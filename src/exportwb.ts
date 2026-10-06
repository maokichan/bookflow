// 工作台导出器：块图 + 页图 → 该书目录下 workbench.html（单文件，数据内联，页图相对路径）。
// 块图每前进一步都可重新导出；工作台自身无持久状态（裁决走日志）。
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { loadGraph } from "./model.ts";
import { argBook, pathsFor } from "./library.ts";

const P = pathsFor(argBook());
const BOOK = P.dir.split(path.sep).pop(); // 书号（工作台用它调存版接口）
const g = loadGraph(P.graph);
if (!existsSync(P.pagesDir)) {
  console.error("页图目录不存在 —— 先对该书运行渲染");
  process.exit(1);
}
const tpl = readFileSync(path.join(import.meta.dirname, "workbench-template.html"), "utf-8");
// blocks 全量内联（含 history/absorbedInto 等）：Ctrl+S 把工作台块图整份写回，字段必须无损往返
const payload = JSON.stringify({
  bookId: BOOK,
  title: g.title,
  source: g.source,
  createdAt: g.createdAt,
  graphVersion: g.version, // 存版对账：保存时回传 baseVersion，服务端与块图现版本比对，陈旧产物拒收
  pages: g.pages,
  blocks: g.blocks,
}).replace(/<\/script>/gi, "<\\/script>");

// 页图与工作台同在书目录下，相对路径即 pages/
const html = tpl.replace("/*__DATA__*/null;", `var PAGES_BASE = "pages/";\nvar DATA = ` + payload + ";");
writeFileSync(P.workbench, html, "utf-8");
console.log(`工作台 → ${P.workbench}（${(html.length / 1024).toFixed(0)} KB，块 ${g.blocks.length}，页 ${g.pages.length}）`);
console.log(`书架里点开，或浏览器打开 file://${P.workbench.replaceAll("\\", "/")}；裁决日志放入该书 inbox/ 后回放`);
