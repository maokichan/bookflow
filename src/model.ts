// 块图数据模型 —— 全流程单一事实源。
// 类型与状态命名对齐《书稿流水线架构.md》§0/§1；只允许可擦除 TS（Node 原生 type stripping）。
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------- 类型 ----------
export type BlockType =
  | "flow"        // 流转块：正文叙述，翻译对象
  | "structure"   // 结构块：章题/节题/目录项
  | "furniture"   // 页面附着块：页眉/页脚/页码，归档不译
  | "annotation"  // 锚定支流块：脚注/边注/译注（锚点关系 MVP 未建，人工兜底）
  | "asset"       // 资产占位块：图/表/公式
  | "untyped";    // 未分型：引用/引语等，人工校对 #1 兜底分类

export type BlockState =
  | "raw" | "typed" | "原文已定" | "已译" | "译文已定" | "复查完毕" | "已采纳";

// 状态机权限（架构 §1）：机器只推动 typed/已译，"已定"与"已采纳"只归人。
// MVP 回放器只放行人工闸门动作；机器闸门是将来 S0/S3 完成时的自签章。
export const GATE_TRANSITIONS: Record<string, BlockState[]> = {
  raw: ["typed"],
  typed: ["原文已定"],
  "原文已定": ["typed", "已译"],
  "已译": ["译文已定"],
  "译文已定": ["已译", "复查完毕"],
  "复查完毕": ["已采纳", "译文已定"],
  "已采纳": [],
};

export const HUMAN_STATES: BlockState[] = ["原文已定", "译文已定", "已采纳"];

// ---------- 实体 ----------
export interface BBox { x0: number; y0: number; x1: number; y1: number } // 左上原点，PDF 点

export interface HistoryEntry {
  ts: string;
  action: string;
  by: string; // "machine:extract" | "human:workbench"
  note?: string;
}

export interface Block {
  id: string; // p<page>-b<seq>，页内序号；块为页局部（跨页段落按页拆分）
  page: number; // 1-based
  bbox: BBox;
  type: BlockType;
  state: BlockState;
  text: string;
  bold: boolean;
  findings: unknown[]; // MVP：机器条子未启用，结构预留
  history: HistoryEntry[];
}

export interface BlockGraph {
  version: number;
  source: string; // 源 PDF 相对路径
  title: string;
  createdAt: string;
  pages: { w: number; h: number }[];
  blocks: Block[];
}

// ---------- IO ----------
export const PATHS = {
  graph: path.join(ROOT, "data", "blockgraph.json"),
  pagesDir: path.join(ROOT, "data", "pages"),
  workbenchDir: path.join(ROOT, "workbench"),
  inbox: path.join(ROOT, "inbox"),
  processed: path.join(ROOT, "inbox", "processed"),
};

export function loadGraph(): BlockGraph {
  if (!existsSync(PATHS.graph)) {
    console.error(`未找到 ${PATHS.graph} —— 先运行 npm run extract`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(PATHS.graph, "utf-8"));
}

export function saveGraph(g: BlockGraph): void {
  g.version += 1;
  writeFileSync(PATHS.graph, JSON.stringify(g, null, 2), "utf-8");
}

export function findBlock(g: BlockGraph, id: string): Block | undefined {
  return g.blocks.find((b) => b.id === id);
}
