// 块图数据模型 —— 全流程单一事实源。
// 类型与状态命名对齐《书稿流水线架构.md》§0/§1；只允许可擦除 TS（Node 原生 type stripping）。
import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
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
  level?: number; // 结构块的层级（0 = 封面/目录等特殊节点，1 章 2 节 3 目…）
  role?: string; // 结构角色：封面/目录/前言/导论/章/节/目/附录/后记/参考文献
  absorbedInto?: string; // 被拼合进的目标块 id（覆盖率守恒：显式吸收，不是消失）
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
// 路径按书寻址（每书一目录，见 library.ts）；model 不依赖注册表，只认块图路径。
export function loadGraph(graphPath: string): BlockGraph {
  if (!existsSync(graphPath)) {
    console.error(`未找到 ${graphPath} —— 先对该书运行抽取`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(graphPath, "utf-8"));
}

// 原子写：写临时文件后 rename，坏写不落盘（裁决数据比代码贵）。
// 版本号在此统一 +1 —— 块图版本单调递增是全项目纪律（抽取/回放/存版/恢复都经这里），
// 工作台存版的 baseVersion 对账靠它成立。
export function saveGraph(graphPath: string, g: BlockGraph): void {
  g.version += 1;
  const tmp = graphPath + ".tmp";
  writeFileSync(tmp, JSON.stringify(g, null, 2), "utf-8");
  renameSync(tmp, graphPath);
}

// 块图当前版本号；文件缺失或损坏返回 null —— 调用方按"未知"处理（对账拒绝、重抽从 0 起算）。
// 损坏与缺失必须分开喊：损坏被当"没抽过"会诱发覆盖性重抽，每次读都喊则跟着轮询刷屏 —— 只喊一次。
const corruptedWarned = new Set<string>();
function softRead<T>(graphPath: string): T | null {
  if (!existsSync(graphPath)) return null;
  try { return JSON.parse(readFileSync(graphPath, "utf-8")); }
  catch (e) {
    if (!corruptedWarned.has(graphPath)) {
      console.warn(`块图存在但解析失败（当它不存在用）—— ${graphPath}`, e);
      corruptedWarned.add(graphPath);
    }
    return null;
  }
}
export function readGraphVersion(graphPath: string): number | null {
  return softRead<{ version?: number }>(graphPath)?.version ?? null;
}

// 宽松读块图：缺失或损坏返回 null（状态页/行为判定用；写路径用 loadGraph 的严格版）
export function loadGraphSoft(graphPath: string): BlockGraph | null {
  return softRead<BlockGraph>(graphPath);
}

export function findBlock(g: BlockGraph, id: string): Block | undefined {
  return g.blocks.find((b) => b.id === id);
}

// 跨页段落拼合的文本连接规则（与抽取的行拼接一致：中文直连、拉丁补空格）
export function joinParaText(a: string, b: string): string {
  const c = (a ?? "").replace(/\s+$/, "");
  const d = (b ?? "").replace(/^\s+/, "");
  if (!c) return d;
  if (!d) return c;
  const cjkL = /[\u3000-\u9fff\uf900-\ufaff\u3040-\u30ff。，、；：？！）》」』】〉”’%)]/.test(c.slice(-1));
  const cjkR = /[\u3000-\u9fff\uf900-\ufaff\u3040-\u30ff《「『【〈“‘(（]/.test(d[0]);
  return cjkL || cjkR ? c + d : c + " " + d;
}
