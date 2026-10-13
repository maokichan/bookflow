// 裁决日志信封：文件头一行 JSON，携带书号与 body 的 sha256。
// 意图：日志是唯一可以人工携走（跨机、跨盘、聊天工具传）的中间产物，
// 头部哈希让传输中的改动/截断/投错收发箱在回放时当场拒收，而不是静默混进块图。
// 无头行或首行非信封的日志按旧格式放行（向后兼容）。
import { createHash } from "node:crypto";

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export function stampLog(book: string, body: string): string {
  const header = {
    bookflow: 1,
    kind: "adjudication",
    book,
    entries: body.split("\n").filter((l) => l.trim()).length,
    sha256: sha256Hex(body),
  };
  return JSON.stringify(header) + "\n" + body;
}

export function verifyLog(content: string, book: string): { ok: true; body: string } | { ok: false; reason: string } {
  const nl = content.indexOf("\n");
  if (nl < 0) return { ok: true, body: content };
  let h: any;
  try { h = JSON.parse(content.slice(0, nl)); } catch { return { ok: true, body: content }; }
  if (!h || h.bookflow !== 1 || h.kind !== "adjudication") return { ok: true, body: content };
  const body = content.slice(nl + 1);
  if (h.book !== book) return { ok: false, reason: `日志信封写的是书 ${h.book} —— 投错收发箱了` };
  if (sha256Hex(body) !== h.sha256) return { ok: false, reason: "内容校验不过 —— 传输中被改动或截断" };
  return { ok: true, body };
}
