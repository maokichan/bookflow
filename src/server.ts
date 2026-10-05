// bookflow 本地服务：书籍状态管理的运行面。
// 书架/状态页 UI + 行为任务队列 + 各书工作台与页图的静态托管，一个端口全覆盖。
// 意图（docs/ARCHITECTURE.md §4）：行为是异步任务，跑一本书绝不阻塞程序；
// 队列当前串行（并发度是配置不是架构），任务并行产出各自产物，块图唯一写者不变。
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, copyFileSync, statSync, rmSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./model.ts";
import { LIBRARY, loadRegistry, saveRegistry, bookDir, pathsFor, deriveStage, BEHAVIORS, type BookMeta } from "./library.ts";

const PORT = Number(process.env.BOOKFLOW_PORT ?? 8477);

// ---------- 任务队列（串行起步） ----------
interface Task {
  id: string; book: string; behavior: string;
  status: "queued" | "running" | "done" | "error";
  startedAt?: string; endedAt?: string; exitCode?: number | null; output?: string;
}
const tasks: Task[] = []; // 新的在前；完成即落该书 tasks.jsonl
const waiting: Task[] = [];
let running = false;

function enqueue(book: string, behavior: string): Task {
  const t: Task = { id: `${behavior}-${Date.now()}`, book, behavior, status: "queued" };
  tasks.unshift(t);
  waiting.push(t);
  pump();
  return t;
}

function pump(): void {
  if (running || !waiting.length) return;
  const t = waiting.shift()!;
  running = true;
  t.status = "running";
  t.startedAt = new Date().toISOString();
  const child = spawn(process.execPath, [BEHAVIORS[t.behavior], "--book", t.book], { cwd: ROOT });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  child.on("close", (code) => {
    t.status = code === 0 ? "done" : "error";
    t.exitCode = code;
    t.endedAt = new Date().toISOString();
    t.output = out.slice(-4000);
    try { appendFileSync(pathsFor(t.book).tasks, JSON.stringify(t) + "\n"); } catch {}
    running = false;
    pump();
  });
}

// ---------- 科目导入：书被项目记住的第一步 ----------
function slugify(s: string): string {
  const ascii = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return ascii || "b" + Date.now().toString(36);
}
function importBookData(title: string, idGiven: string | undefined, pdf: Buffer, origin: string): BookMeta {
  if (!title?.trim()) throw new Error("需要书名");
  if (pdf.length < 5 || pdf.subarray(0, 5).toString("latin1") !== "%PDF-") throw new Error("不是 PDF 文件");
  const books = loadRegistry();
  let id = (idGiven?.trim() || slugify(title)).replace(/[\\/\0]/g, "");
  if (books.some((b) => b.id === id)) throw new Error(`书号 ${id} 已被占用`);
  const dir = bookDir(id);
  mkdirSync(path.join(dir, "inbox", "processed"), { recursive: true });
  writeFileSync(pathsFor(id).source, pdf); // 红线：图书馆只读，导入即复制
  const meta: BookMeta = { id, title: title.trim(), createdAt: new Date().toISOString(), origin };
  books.push(meta);
  saveRegistry(books);
  return meta;
}
function importBook(body: { pdfPath?: string; title?: string; id?: string }): BookMeta {
  const p = body.pdfPath?.trim().replace(/^~(?=$|\/|\\)/, process.env.USERPROFILE ?? "");
  if (!p || !p.toLowerCase().endsWith(".pdf")) throw new Error("需要 PDF 路径");
  const src = path.resolve(p);
  if (!existsSync(src) || !statSync(src).isFile()) throw new Error(`文件不存在 ${src}`);
  return importBookData(body.title ?? "", body.id, readFileSync(src), src);
}

// ---------- HTTP ----------
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".png": "image/png", ".json": "application/json",
  ".pdf": "application/pdf", ".jsonl": "application/x-ndjson", ".js": "text/javascript",
};

function json(res: import("node:http").ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readBody(req: import("node:http").IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let s = "";
    req.on("data", (d) => (s += d));
    req.on("end", () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const p = url.pathname;
  try {
    if (p === "/" || p === "/app") {
      const html = readFileSync(path.join(import.meta.dirname, "app-template.html"), "utf-8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    if (p === "/api/books" && req.method === "GET") {
      const inflight = new Set(tasks.filter((t) => t.status === "queued" || t.status === "running").map((t) => t.book));
      json(res, 200, loadRegistry().map((m) => ({ ...m, stage: deriveStage(m.id), inflight: inflight.has(m.id) })));
      return;
    }
    if (p === "/api/books" && req.method === "POST") {
      json(res, 200, importBook(await readBody(req)));
      return;
    }
    if (p === "/api/books/upload" && req.method === "POST") {
      // 文件资源管理器导入：浏览器端选文件，原始字节直传（无 multipart 依赖）
      const q = url.searchParams;
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      json(res, 200, importBookData(q.get("title") ?? "", q.get("id") ?? undefined,
        Buffer.concat(chunks), q.get("name") ?? "本机文件"));
      return;
    }
    const bookTask = p.match(/^\/api\/books\/([^/]+)\/tasks$/);
    if (bookTask && req.method === "POST") {
      const id = decodeURIComponent(bookTask[1]);
      if (!findBook(id)) { json(res, 404, { error: `书 ${id} 未登记` }); return; }
      const { behavior } = await readBody(req);
      if (!BEHAVIORS[behavior]) { json(res, 400, { error: `未知行为 ${behavior}` }); return; }
      json(res, 200, enqueue(id, behavior));
      return;
    }
    const bookDetail = p.match(/^\/api\/books\/([^/]+)$/);
    if (bookDetail && req.method === "GET") {
      const id = decodeURIComponent(bookDetail[1]);
      const meta = findBook(id);
      if (!meta) { json(res, 404, { error: `书 ${id} 未登记` }); return; }
      json(res, 200, { ...meta, stage: deriveStage(id) });
      return;
    }
    if (p === "/api/tasks" && req.method === "GET") {
      json(res, 200, tasks.slice(0, 100));
      return;
    }
    if (p.startsWith("/library/")) {
      serveLibrary(p.slice("/library/".length), res);
      return;
    }
    json(res, 404, { error: "no route" });
  } catch (e: any) {
    json(res, 400, { error: String(e.message ?? e) });
  }
});

function findBook(id: string): BookMeta | undefined {
  return loadRegistry().find((b) => b.id === id);
}

// 静态：只服务 library/ 内的文件（页图、工作台），防目录穿越
function serveLibrary(rel: string, res: import("node:http").ServerResponse): void {
  const full = path.normalize(path.join(LIBRARY, decodeURIComponent(rel)));
  if (!full.startsWith(LIBRARY) || !existsSync(full) || !statSync(full).isFile()) {
    res.writeHead(404); res.end("not found"); return;
  }
  res.writeHead(200, { "content-type": MIME[path.extname(full)] ?? "application/octet-stream" });
  res.end(readFileSync(full));
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`bookflow 书架 → http://127.0.0.1:${PORT}/`);
});
