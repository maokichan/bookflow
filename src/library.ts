// 书籍状态管理的数据面：科目注册表、每书路径、阶段推导。
// 意图：书被项目记住（library/index.json），一切工具按书号寻址，不存在隐蔽默认科目。
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./model.ts";

export const LIBRARY = path.join(ROOT, "library");
const REGISTRY = path.join(LIBRARY, "index.json");

export interface BookMeta {
  id: string;
  title: string;
  createdAt: string;
  origin?: string; // 源 PDF 原始位置（图书馆只读，这里只记出处）
}

export function loadRegistry(): BookMeta[] {
  if (!existsSync(REGISTRY)) return [];
  return JSON.parse(readFileSync(REGISTRY, "utf-8")).books ?? [];
}

export function saveRegistry(books: BookMeta[]): void {
  writeFileSync(REGISTRY, JSON.stringify({ books }, null, 2), "utf-8");
}

export function bookDir(id: string): string {
  const dir = path.join(LIBRARY, id);
  if (!id || /[\\/\0]/.test(id) || id.startsWith(".")) throw new Error(`非法书号 ${id}`);
  return dir;
}

export function getBook(id: string): BookMeta {
  const meta = loadRegistry().find((b) => b.id === id);
  if (!meta) throw new Error(`注册表中没有书 ${id}`);
  return meta;
}

export interface BookPaths {
  dir: string;
  source: string;
  graph: string;
  pagesDir: string;
  workbench: string;
  inbox: string;
  processed: string;
  tasks: string;
}

export function pathsFor(id: string): BookPaths {
  const dir = bookDir(id);
  return {
    dir,
    source: path.join(dir, "source.pdf"),
    graph: path.join(dir, "blockgraph.json"),
    pagesDir: path.join(dir, "pages"),
    workbench: path.join(dir, "workbench.html"),
    inbox: path.join(dir, "inbox"),
    processed: path.join(dir, "inbox", "processed"),
    tasks: path.join(dir, "tasks.jsonl"),
  };
}

// CLI 工具的寻址入口：--book <id>（支持 "--book x" 与 "--book=x"）
export function argBook(): string {
  const a = process.argv;
  const i = a.indexOf("--book");
  const v = i >= 0 ? a[i + 1] : a.find((x) => x.startsWith("--book="))?.split("=")[1];
  if (!v) {
    console.error("缺少 --book <id> —— 一切工具按书号寻址（科目在 library/index.json 登记）");
    process.exit(1);
  }
  const known = loadRegistry().some((b) => b.id === v);
  if (!known) {
    console.error(`书 ${v} 未登记 —— 先在书架导入`);
    process.exit(1);
  }
  return v;
}

// ---------- 阶段推导：书级状态 = 阶段完成度 + 在途任务（任务由服务层补充） ----------
export interface BookStage {
  extracted: boolean;
  rendered: boolean;
  exported: boolean;
  pageCount: number;
  blockStates: Record<string, number>;
  blockTypes: Record<string, number>;
  blockCount: number;
}

export function deriveStage(id: string): BookStage {
  const P = pathsFor(id);
  const stage: BookStage = {
    extracted: false, rendered: false, exported: false,
    pageCount: 0, blockStates: {}, blockTypes: {}, blockCount: 0,
  };
  if (existsSync(P.graph)) {
    const g = JSON.parse(readFileSync(P.graph, "utf-8"));
    stage.extracted = true;
    stage.pageCount = g.pages?.length ?? 0;
    stage.blockCount = g.blocks?.length ?? 0;
    for (const b of g.blocks) {
      stage.blockStates[b.state] = (stage.blockStates[b.state] ?? 0) + 1;
      stage.blockTypes[b.type] = (stage.blockTypes[b.type] ?? 0) + 1;
    }
  }
  if (existsSync(P.pagesDir)) stage.rendered = readdirSync(P.pagesDir).some((f) => f.endsWith(".png"));
  stage.exported = existsSync(P.workbench);
  return stage;
}

// ---------- 进度（意图：百分比诚实反映"离成书还差多少"） ----------
// 口径：识别基建 15%（块图/页图/工作台各 5）+ 原文校对 45%（应校非附着块中已定占比）
//      + 翻译 20% + 双语校对 10% + 机器检查与采纳 10%。
// 未点亮的阶段恒 0 —— 不虚报。
export function progress(id: string): { pct: number; proofDone: number; proofTotal: number } {
  const st = deriveStage(id);
  let pct = 0;
  if (st.extracted) pct += 5;
  if (st.rendered) pct += 5;
  if (st.exported) pct += 5;
  const proofTotal = Math.max(0, st.blockCount - (st.blockTypes.furniture ?? 0));
  const proofDone = st.blockStates["原文已定"] ?? 0;
  if (proofTotal > 0) pct += 45 * (proofDone / proofTotal);
  return { pct: Math.round(pct * 10) / 10, proofDone, proofTotal };
}

// 行为名 → CLI 文件（服务层与 CLI 共用一份实现）
export const BEHAVIORS: Record<string, string> = {
  extract: "src/extract.ts",
  render: "src/renderpages.ts",
  export: "src/exportwb.ts",
  replay: "src/replay.ts",
};

// 用户语义的行为：一步"识别" = 抽取 + 页图 + 工作台，内部按序执行（用户不需要知道拆解）
export const BEHAVIOR_STEPS: Record<string, string[]> = {
  process: ["extract", "render", "export"],
};
