// 裁决日志回放器：块图的唯一写者。
// 消费该书 inbox/*.jsonl（append-only 人工动作），逐条校验前置状态后应用到块图，
// 已消费日志移入 inbox/processed/。违反前置条件的动作被拒并计入报告，不静默。
// 信封日志（logheader.ts）先验哈希与书号：损坏或投错收发箱的文件整份拒收、留在 inbox/，退出码 1。
import { readFileSync, readdirSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import { loadGraph, saveGraph, findBlock, joinParaText, GATE_TRANSITIONS, type Block, type BlockState } from "./model.ts";
import { argBook, pathsFor } from "./library.ts";
import { verifyLog } from "./logheader.ts";

const BOOK = argBook();
const P = pathsFor(BOOK);
mkdirSync(P.processed, { recursive: true });
const logs = readdirSync(P.inbox).filter((f) => f.endsWith(".jsonl")).sort();
if (!logs.length) {
  console.log("inbox/ 为空 —— 没有待回放的裁决日志");
  process.exit(0);
}

const g = loadGraph(P.graph);
const VALID_TYPES = new Set(["flow", "structure", "furniture", "annotation", "asset", "untyped"]);
const report = { applied: 0, rejected: [] as string[], refused: [] as string[] };
const appliedBy: Record<string, number> = {};

const isBBox = (bb: any): boolean =>
  !!bb && [bb.x0, bb.y0, bb.x1, bb.y1].every((n: any) => typeof n === "number" && Number.isFinite(n));

for (const f of logs) {
  const full = path.join(P.inbox, f);
  const v = verifyLog(readFileSync(full, "utf-8"), BOOK);
  if (!v.ok) {
    report.refused.push(`${f} —— ${v.reason}（整份未消费，留在 inbox/）`);
    continue;
  }
  const lines = v.body.split("\n").filter((l) => l.trim());
  for (let i = 0; i < lines.length; i++) {
    const where = `${f}#${i + 1}`;
    let a: any;
    try { a = JSON.parse(lines[i]); } catch { report.rejected.push(`${where} 解析失败`); continue; }

    // declare 是唯一"无中生有"的动作：目标块尚不存在，先于 findBlock 处理
    let b: Block | undefined;
    if (a.action === "declare") {
      const nb = a.payload?.block;
      if (!nb || nb.id !== a.block) { report.rejected.push(`${where} 载荷块号与动作块号不一致`); continue; }
      if (findBlock(g, nb.id)) { report.rejected.push(`${where} 块 ${nb.id} 已存在`); continue; }
      if (nb.type !== "asset") { report.rejected.push(`${where} 拉框标块 MVP 仅素材（${nb.type}）`); continue; }
      if (nb.state !== "typed") { report.rejected.push(`${where} 新块须为 typed`); continue; }
      if (!isBBox(nb.bbox) || nb.bbox.x0 >= nb.bbox.x1 || nb.bbox.y0 >= nb.bbox.y1
        || !Number.isInteger(nb.page) || nb.page < 1 || nb.page > g.pages.length) {
        report.rejected.push(`${where} 素材页码/框非法`); continue;
      }
      const clean: Block = {
        id: String(nb.id), page: nb.page,
        bbox: { x0: nb.bbox.x0, y0: nb.bbox.y0, x1: nb.bbox.x1, y1: nb.bbox.y1 },
        type: "asset", state: "typed",
        text: typeof nb.text === "string" ? nb.text : "",
        bold: false, findings: [], history: [],
      };
      let at = g.blocks.length; // 书序插入：页码优先，同页按 y0
      for (let k = 0; k < g.blocks.length; k++) {
        const x = g.blocks[k];
        if (x.page > clean.page || (x.page === clean.page && x.bbox.y0 > clean.bbox.y0)) { at = k; break; }
      }
      g.blocks.splice(at, 0, clean);
      clean.history.push({ ts: a.ts, action: "declare", by: "human:workbench" });
      appliedBy.declare = (appliedBy.declare ?? 0) + 1;
      report.applied++;
      continue; // 新块已立账，不进下方既有块动作链
    } else {
      b = findBlock(g, a.block);
      if (!b) { report.rejected.push(`${where} 未知块 ${a.block}`); continue; }
    }

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
      // 载荷可带 level/role（撤销结构标注用 null 清除）；不带则不动 —— 旧日志不受影响
      if (a.payload.level !== undefined) b.level = a.payload.level ?? undefined;
      if (a.payload.role !== undefined) b.role = a.payload.role ?? undefined;
    } else if (a.action === "structure") {
      // 手动结构对齐：纯层级（1=最浅）。程序不问这本书的分类叫法，只认层级本身；
      // 旧日志可能带 role 字段——忽略不存（角色体系已移除）。
      if (!Number.isInteger(a.payload?.level) || a.payload.level < 0 || a.payload.level > 6) {
        report.rejected.push(`${where} ${b.id} 非法结构层级 ${a.payload?.level}`); continue;
      }
      b.type = "structure";
      b.level = a.payload.level;
      b.role = undefined;
    } else if (a.action === "merge") {
      // 拼合自由化：人指哪块拼哪块，类型不再限流转（标题折行、段落被公式/素材行隔断都是真实场景）。
      // 保留防数据打架的三条：候选在书序之后；中途不跨未拼的正文/标题（阅读顺序的骨架）；
      // 已拼走的先拆才能再拼。文本只连接首尾两块，中间块原样保留，不并入。
      const target = findBlock(g, a.payload?.absorb);
      if (!target) { report.rejected.push(`${where} ${b.id} 吸收目标不存在`); continue; }
      if (b.absorbedInto) { report.rejected.push(`${where} ${b.id} 已被 ${b.absorbedInto} 拼走，不能作拼合主块`); continue; }
      if (target.absorbedInto) { report.rejected.push(`${where} ${target.id} 已被 ${target.absorbedInto} 吸收`); continue; }
      const ai = g.blocks.indexOf(b), bi = g.blocks.indexOf(target);
      if (ai < 0 || bi <= ai) { report.rejected.push(`${where} 拼合目标须在书序之后`); continue; }
      if (g.blocks.slice(ai + 1, bi).some((x) => !x.absorbedInto && (x.type === "flow" || x.type === "structure"))) {
        report.rejected.push(`${where} ${b.id} 与 ${target.id} 之间夹着正文/标题，不可跨越拼合`); continue;
      }
      b.text = joinParaText(b.text, target.text);
      // 同页拼合框并为一个；跨页块图仍页局部，主块只保本页框（工作台显示层补画附属框）
      if (b.page === target.page) {
        b.bbox = {
          x0: Math.min(b.bbox.x0, target.bbox.x0), y0: Math.min(b.bbox.y0, target.bbox.y0),
          x1: Math.max(b.bbox.x1, target.bbox.x1), y1: Math.max(b.bbox.y1, target.bbox.y1),
        };
      }
      target.absorbedInto = b.id;
      target.history.push({ ts: a.ts, action: "merge-absorbed", by: "human:workbench" });
    } else if (a.action === "unmerge") {
      // 拼合的撤销：主块文本与框回到拼合前（载荷即拼合前快照），被吸收块恢复独立
      const target = findBlock(g, a.payload?.absorb);
      if (!target) { report.rejected.push(`${where} ${b.id} 吸收目标不存在`); continue; }
      if (target.absorbedInto !== b.id) { report.rejected.push(`${where} ${target.id} 未被 ${b.id} 吸收`); continue; }
      if (typeof a.payload?.text !== "string" || !a.payload.text.trim() || !isBBox(a.payload.bbox)) {
        report.rejected.push(`${where} ${b.id} 撤销拼合载荷非法`); continue;
      }
      b.text = a.payload.text;
      b.bbox = { x0: a.payload.bbox.x0, y0: a.payload.bbox.y0, x1: a.payload.bbox.x1, y1: a.payload.bbox.y1 };
      target.absorbedInto = undefined;
      target.history.push({ ts: a.ts, action: "unmerge-restored", by: "human:workbench" });
    } else if (a.action === "undeclare") {
      // 拉标的撤销：仅未校（typed）且无人吸收的块可移除
      if (b.state !== "typed") { report.rejected.push(`${where} ${b.id} 已过 typed，不可撤标`); continue; }
      if (g.blocks.some((x) => x.absorbedInto === b.id)) { report.rejected.push(`${where} ${b.id} 已被吸收，不可撤标`); continue; }
      g.blocks.splice(g.blocks.indexOf(b), 1);
      appliedBy[a.action] = (appliedBy[a.action] ?? 0) + 1;
      report.applied++;
      continue; // 块已移出图，不再回写 history
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
if (report.refused.length) {
  for (const r of report.refused) console.error("  ⛔", r);
  process.exit(1); // 信封验签失败 = 数据完整性问题，不是普通拒动作 —— 让任务链显式失败
}
