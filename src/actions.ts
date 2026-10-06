// 用户交互行为表 —— 书级交互资格的唯一真相（2026-10-06 技术债审查后立项）。
// 口径（TODO）：把"人能做的事"枚举成封闭集合（谁、在书的什么阶段、能对什么做什么），
// 表之外显然不合法（默认拒绝）；状态转移是这张表的影子而非主角。
// 分工：块级动作（gate/edit/merge…）的前置校验归回放器（replay.ts，成品范例）；
// 书级行为归本表 —— 服务端是执法者（server.ts 各写路径先查表），
// 书架 UI 拿 bookActs() 的判定画锁与理由，不再各自为政；CLI 走同一张表，--force 是唯一显式越权通道。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { pathsFor } from "./library.ts";
import { loadGraphSoft } from "./model.ts";

export interface Verdict { ok: boolean; reason?: string }

const OK: Verdict = { ok: true };
const no = (reason: string): Verdict => ({ ok: false, reason });

// 块图是否已含人工成果：人工历史、拼合吸收，或 inbox 里待回放的裁决日志。
// 判"有"从宽 —— 块图读不出来时也按有人工成果对待，宁可误拒不可误毁。
export function graphHasHumanWork(graph: unknown): boolean {
  if (!graph) return false;
  const g = graph as { blocks?: any[] };
  return (g.blocks ?? []).some((b: any) =>
    b.absorbedInto
    || (b.history ?? []).some((h: any) => String(h?.by ?? "").startsWith("human:")));
}

function inboxPending(id: string): boolean {
  const P = pathsFor(id);
  if (!existsSync(P.inbox)) return false;
  return readdirSync(P.inbox).some((f) => f.endsWith(".jsonl"));
}

// 单一行为判定。ctx.graph 可传入已加载的块图（省一次解析）；ctx.inflight 传该书在途任务名。
export function verdictFor(id: string, act: string, ctx: { inflight?: string; graph?: unknown } = {}): Verdict {
  const P = pathsFor(id);
  const graph = ctx.graph !== undefined ? ctx.graph : loadGraphSoft(P.graph);
  switch (act) {
    case "process": // 识别（抽取→页图→工作台）：预处理门 + 重抽会毁人工裁决
      if (ctx.inflight) return no(`任务在途（${ctx.inflight}），完成后再排`);
      let confirmed = false;
      try { confirmed = !!JSON.parse(readFileSync(P.params, "utf-8")).confirmedAt; } catch {}
      if (!confirmed) return no("先完成预处理（确定预处理后解锁识别）");
      if (graphHasHumanWork(graph) || inboxPending(id))
        return no("块图已含人工裁决或待回放日志 —— 重抽会覆盖；确要重来，先恢复「识别完成」版");
      return OK;
    case "extract": // 抽取原语：CLI 与服务端同表；--force 显式越权
      if (graphHasHumanWork(graph) || inboxPending(id))
        return no("块图已含人工裁决或待回放日志 —— 重抽会覆盖（--force 显式越权）");
      return OK;
    case "render":
      if (!existsSync(P.source)) return no("源 PDF 缺失");
      return OK;
    case "reprocess":
    case "export":
    case "replay":
      if (!graph) return no("块图不存在 —— 先识别");
      return OK;
    default:
      return no(`表外行为 ${act} —— 默认拒绝`); // 封闭表：之外即非法
  }
}

// 书架/详情页用的判定快照（只含 UI 要画的几个；存版的对账在保存当场做）
export function bookActs(id: string, graph: unknown): Record<string, Verdict> {
  return {
    process: verdictFor(id, "process", { graph }),
    reprocess: verdictFor(id, "reprocess", { graph }),
    replay: verdictFor(id, "replay", { graph }),
  };
}
