// 裁决日志回放器：块图的唯一写者。
// 消费该书 inbox/*.jsonl（append-only 人工动作），逐条校验前置状态后应用到块图，
// 已消费日志移入 inbox/processed/。违反前置条件的动作被拒并计入报告，不静默。
import { readFileSync, readdirSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import { loadGraph, saveGraph, findBlock, GATE_TRANSITIONS, type BlockState } from "./model.ts";
import { argBook, pathsFor } from "./library.ts";

const P = pathsFor(argBook());
mkdirSync(P.processed, { recursive: true });
const logs = readdirSync(P.inbox).filter((f) => f.endsWith(".jsonl")).sort();
if (!logs.length) {
  console.log("inbox/ 为空 —— 没有待回放的裁决日志");
  process.exit(0);
}

const g = loadGraph(P.graph);
const VALID_TYPES = new Set(["flow", "structure", "furniture", "annotation", "asset", "untyped"]);
const report = { applied: 0, rejected: [] as string[] };
const appliedBy: Record<string, number> = {};

for (const f of logs) {
  const full = path.join(P.inbox, f);
  const lines = readFileSync(full, "utf-8").split("\n").filter((l) => l.trim());
  for (let i = 0; i < lines.length; i++) {
    const where = `${f}#${i + 1}`;
    let a: any;
    try { a = JSON.parse(lines[i]); } catch { report.rejected.push(`${where} 解析失败`); continue; }
    const b = findBlock(g, a.block);
    if (!b) { report.rejected.push(`${where} 未知块 ${a.block}`); continue; }

    if (a.action === "gate") {
      const allowed = GATE_TRANSITIONS[b.state] ?? [];
      if (!allowed.includes(a.payload?.state)) {
        report.rejected.push(`${where} ${b.id} 非法转移 ${b.state}→${a.payload?.state}`);
        continue;
      }
      b.state = a.payload.state as BlockState;
    } else if (a.action === "edit") {
      if (typeof a.payload?.text !== "string" || !a.payload.text.trim()) {
        report.rejected.push(`${where} ${b.id} 改文载荷非法`); continue;
      }
      b.text = a.payload.text;
    } else if (a.action === "reclassify") {
      if (!VALID_TYPES.has(a.payload?.type)) {
        report.rejected.push(`${where} ${b.id} 未知类型 ${a.payload?.type}`); continue;
      }
      b.type = a.payload.type;
    } else if (a.action === "structure") {
      // 手动结构对齐：块标进层级树（1 章 / 2 节 / 3 目…），同时定型为结构块
      if (!Number.isInteger(a.payload?.level) || a.payload.level < 1 || a.payload.level > 6) {
        report.rejected.push(`${where} ${b.id} 非法结构层级 ${a.payload?.level}`); continue;
      }
      b.type = "structure";
      b.level = a.payload.level;
    } else {
      report.rejected.push(`${where} 未知动作 ${a.action}`); continue;
    }
    b.history.push({ ts: a.ts, action: a.action, by: "human:workbench" });
    appliedBy[a.action] = (appliedBy[a.action] ?? 0) + 1;
    report.applied++;
  }
  renameSync(full, path.join(P.processed, f));
}

saveGraph(P.graph, g);
console.log(`应用 ${report.applied} 条：`, appliedBy);
if (report.rejected.length) {
  console.log(`拒绝 ${report.rejected.length} 条：`);
  for (const r of report.rejected) console.log("  ✗", r);
}
console.log(`块图 → v${g.version}（${P.graph}）`);
