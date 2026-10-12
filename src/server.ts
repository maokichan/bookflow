// bookflow 本地服务：书籍状态管理的运行面。
// 书架/状态页 UI + 行为任务队列 + 各书工作台与页图的静态托管，一个端口全覆盖。
// 意图（docs/ARCHITECTURE.md §4）：行为是异步任务，跑一本书绝不阻塞程序；
// 队列当前串行（并发度是配置不是架构），任务并行产出各自产物，块图唯一写者不变。
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, statSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { ROOT, loadGraphSoft, readGraphVersion, saveGraph } from "./model.ts";
import { loadRegistry, saveRegistry, bookDir, pathsFor, deriveStage, progress, libraryRoot, homeConfigured, setLibraryRoot, BEHAVIORS, BEHAVIOR_STEPS, type BookMeta } from "./library.ts";
import { verdictFor, bookActs } from "./actions.ts";
import { renderPagesToBuffers, pdfPageCount, hasTextLayer, FX_DEFAULTS, fxHash, type Fx } from "./pageimg.ts";

const PORT = Number(process.env.BOOKFLOW_PORT ?? 8477);
const CONFIG = () => path.join(libraryRoot(), "config.json"); // 功能层级：引擎配置的家（含密钥，不入库）

// ---------- 任务队列（串行起步；复合行为按步链执行，如 识别 = 抽取→页图→工作台） ----------
interface Task {
  id: string; book: string; behavior: string; steps: string[]; stepIdx: number;
  status: "queued" | "running" | "done" | "error";
  startedAt?: string; endedAt?: string; exitCode?: number | null; output?: string;
}
const tasks: Task[] = []; // 新的在前；完成即落该书 tasks.jsonl
const waiting: Task[] = [];
let running = false;

const inflightOf = (id: string): Task | undefined =>
  tasks.find((t) => t.book === id && (t.status === "queued" || t.status === "running"));

function enqueue(book: string, behavior: string): Task {
  const t: Task = {
    id: `${behavior}-${Date.now()}`, book, behavior,
    steps: BEHAVIOR_STEPS[behavior] ?? [behavior], stepIdx: 0, status: "queued",
  };
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
  spawnStep(t);
}

function spawnStep(t: Task): void {
  const step = t.steps[t.stepIdx];
  const child = spawn(process.execPath, [BEHAVIORS[step], "--book", t.book], { cwd: ROOT });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  child.on("close", (code) => {
    if (code === 0 && t.stepIdx < t.steps.length - 1) { t.stepIdx++; spawnStep(t); return; }
    t.status = code === 0 ? "done" : "error";
    t.exitCode = code;
    t.endedAt = new Date().toISOString();
    t.output = out.slice(-4000);
    try { appendFileSync(pathsFor(t.book).tasks, JSON.stringify(t) + "\n"); }
    catch (e) { console.error(`[server] 任务记录落盘失败（${t.book}）——`, e); }
    if (code === 0) {
      try {
        if (t.behavior === "process") snapshot(t.book, "识别完成");
        else if (t.behavior === "replay") snapshot(t.book, "回放后");
      } catch (e) { console.error(`[server] 自动存版失败（${t.book}）——`, e); }
    }
    running = false;
    pump();
  });
}

// ---------- 版本：书籍处理状态的完整快照（git 风格；手动的全留，自动的清到最近 20 个） ----------
function snapshot(book: string, label?: string): any {
  const P = pathsFor(book);
  const vdir = path.join(P.dir, "versions");
  mkdirSync(vdir, { recursive: true });
  const g = JSON.parse(readFileSync(P.graph, "utf-8"));
  const done = g.blocks.filter((b: any) => b.state === "原文已定").length;
  const list = readdirSync(vdir).filter((f) => f.endsWith(".json"));
  const v = list.length ? Math.max(...list.map((f) => JSON.parse(readFileSync(path.join(vdir, f), "utf-8")).v ?? 0)) + 1 : 1;
  const snap = { v, label: label ?? "", ts: new Date().toISOString(), blocks: g.blocks.length, done, graph: g };
  const name = `v${String(v).padStart(3, "0")}.json`;
  writeFileSync(path.join(vdir, name), JSON.stringify(snap), "utf-8");
  const autos = list.map((f) => ({ f, j: JSON.parse(readFileSync(path.join(vdir, f), "utf-8")) }))
    .filter((x) => !x.j.label).sort((a, b) => b.j.v - a.j.v);
  for (const old of autos.slice(19)) rmSync(path.join(vdir, old.f)); // 自动版留最近 20
  return { v, label: snap.label, ts: snap.ts };
}

// ---------- 科目导入：书被项目记住的第一步 ----------
function slugify(s: string): string {
  const ascii = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return ascii || "b" + Date.now().toString(36);
}
function importBookData(title: string, idGiven: string | undefined, pdf: Buffer, origin: string): BookMeta {
  if (!title?.trim()) throw new UserError("需要书名");
  if (pdf.length < 5 || pdf.subarray(0, 5).toString("latin1") !== "%PDF-") throw new UserError("不是 PDF 文件");
  const books = loadRegistry();
  let id = (idGiven?.trim() || slugify(title)).replace(/[\\/\0]/g, "");
  if (books.some((b) => b.id === id)) throw new UserError(`书号 ${id} 已被占用`);
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
  if (!p || !p.toLowerCase().endsWith(".pdf")) throw new UserError("需要 PDF 路径");
  const src = path.resolve(p);
  if (!existsSync(src) || !statSync(src).isFile()) throw new UserError(`文件不存在 ${src}`);
  try { return importBookData(body.title ?? "", body.id, readFileSync(src), src); }
  catch (e) { if (e instanceof UserError) throw e; throw new UserError(`读不了这个文件 ${src} —— ${e instanceof Error ? e.message : e}`); }
}

// ---------- HTTP ----------
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".png": "image/png", ".json": "application/json",
  ".pdf": "application/pdf", ".jsonl": "application/x-ndjson", ".js": "text/javascript",
};

// 用户输错与程序出走的分界（TODO 错误处理三档）：输错 400 带人话原因，意外 500 留栈控制台。
// 处理器里凡"用户可自行修正"的失败都抛这个；其余异常一律按真 bug 对待。
class UserError extends Error {}

function json(res: import("node:http").ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readBody(req: import("node:http").IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let s = "";
    req.on("data", (d) => (s += d));
    req.on("end", () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(new UserError("请求体不是合法 JSON")); } });
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
    if (p === "/api/home" && req.method === "GET") {
      json(res, 200, { configured: homeConfigured(), libraryRoot: libraryRoot() });
      return;
    }
    if (p === "/api/home" && req.method === "POST") {
      const body = await readBody(req);
      if (!body.path) { json(res, 400, { error: "需要存储路径" }); return; }
      try { setLibraryRoot(body.path); }
      catch (e) { throw new UserError(`建不了存储目录 ${body.path} —— ${e instanceof Error ? e.message : e}`); }
      json(res, 200, { configured: true, libraryRoot: libraryRoot() });
      return;
    }
    if (p === "/api/books" && req.method === "GET") {
      const inflight = new Set(tasks.filter((t) => t.status === "queued" || t.status === "running").map((t) => t.book));
      json(res, 200, loadRegistry().filter((m) => !m.deletedAt).map((m) => {
        const P = pathsFor(m.id);
        const params = existsSync(P.params) ? JSON.parse(readFileSync(P.params, "utf-8")) : null;
        const g = loadGraphSoft(P.graph);
        const st = deriveStage(m.id, g);
        return { ...m, stage: st, progress: progress(m.id, st), params, inflight: inflight.has(m.id), acts: bookActs(m.id, g) };
      }));
      return;
    }
    if (p === "/api/config" && req.method === "GET") {
      json(res, 200, existsSync(CONFIG()) ? JSON.parse(readFileSync(CONFIG(), "utf-8")) : {});
      return;
    }
    if (p === "/api/config" && req.method === "POST") {
      const body = await readBody(req);
      mkdirSync(libraryRoot(), { recursive: true });
      writeFileSync(CONFIG(), JSON.stringify(body, null, 2), "utf-8");
      json(res, 200, { ok: true });
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
      if (!BEHAVIORS[behavior] && !BEHAVIOR_STEPS[behavior]) { json(res, 400, { error: `未知行为 ${behavior}` }); return; }
      const v = verdictFor(id, behavior, { inflight: inflightOf(id)?.behavior });
      if (!v.ok) { json(res, 400, { error: v.reason }); return; } // 行为表执法：表外/资格不符默认拒绝
      json(res, 200, enqueue(id, behavior));
      return;
    }
    const bookDetail = p.match(/^\/api\/books\/([^/]+)$/);
    if (bookDetail && req.method === "GET") {
      const id = decodeURIComponent(bookDetail[1]);
      const meta = findBook(id);
      if (!meta) { json(res, 404, { error: `书 ${id} 未登记` }); return; }
      const P = pathsFor(id);
      const params = existsSync(P.params) ? JSON.parse(readFileSync(P.params, "utf-8")) : null;
      const g = loadGraphSoft(P.graph);
      const st = deriveStage(id, g);
      json(res, 200, { ...meta, stage: st, progress: progress(id, st), params, acts: bookActs(id, g) });
      return;
    }
    const bookParams = p.match(/^\/api\/books\/([^/]+)\/params$/);
    if (bookParams) {
      const id = decodeURIComponent(bookParams[1]);
      if (!findBook(id)) { json(res, 404, { error: `书 ${id} 未登记` }); return; }
      const P = pathsFor(id);
      const stored: any = existsSync(P.params) ? JSON.parse(readFileSync(P.params, "utf-8")) : {};
      if (req.method === "GET") {
        json(res, 200, { contrast: 100, denoise: 0, sharpen: 0, ocr: { engine: "textlayer" }, ...stored });
        return;
      }
      if (req.method === "POST") {
        const inflight = inflightOf(id);
        if (inflight) { json(res, 400, { error: `任务在途（${inflight.behavior}）—— 完成后再调参数` }); return; }
        const body = await readBody(req);
        const fx = {
          contrast: Math.min(300, Math.max(50, Number(body.contrast) || 100)),
          denoise: Math.min(2, Math.max(0, Number(body.denoise) || 0)),
          sharpen: Math.min(200, Math.max(0, Number(body.sharpen) || 0)),
        };
        // 参数一变，产物过期：确认作废，须重新「确定预处理」
        const changed = !stored.confirmedAt
          || stored.contrast !== fx.contrast || stored.denoise !== fx.denoise || stored.sharpen !== fx.sharpen;
        const next = {
          ...stored, ...fx,
          confirmedAt: changed ? null : stored.confirmedAt,
          fxHash: changed ? null : stored.fxHash,
          ocr: { engine: body.ocr?.engine ?? stored.ocr?.engine ?? "textlayer" },
        };
        mkdirSync(P.dir, { recursive: true });
        writeFileSync(P.params, JSON.stringify(next, null, 2), "utf-8");
        json(res, 200, next);
        return;
      }
    }
    const bookConfirm = p.match(/^\/api\/books\/([^/]+)\/preprocess\/confirm$/);
    if (bookConfirm && req.method === "POST") {
      // 确定预处理：产物指纹落定 + 全量按参数重渲（页图集合即产物），完成后才能识别
      const id = decodeURIComponent(bookConfirm[1]);
      if (!findBook(id)) { json(res, 404, { error: `书 ${id} 未登记` }); return; }
      const inflight = inflightOf(id);
      if (inflight) { json(res, 400, { error: `任务在途（${inflight.behavior}）—— 完成后再确定预处理` }); return; }
      const P = pathsFor(id);
      const stored: any = existsSync(P.params) ? JSON.parse(readFileSync(P.params, "utf-8")) : {};
      const fx = { contrast: stored.contrast ?? 100, denoise: stored.denoise ?? 0, sharpen: stored.sharpen ?? 0 };
      const next = { ...stored, ...fx, confirmedAt: new Date().toISOString(), fxHash: fxHash(fx) };
      writeFileSync(P.params, JSON.stringify(next, null, 2), "utf-8");
      enqueue(id, "reprocess");
      json(res, 200, next);
      return;
    }
    const bookSamples = p.match(/^\/api\/books\/([^/]+)\/samples$/);
    if (bookSamples && req.method === "GET") {
      // 预处理采样：按百分比取页，单页低倍率现场渲染（同参数 = 同输出，不入产物）
      const id = decodeURIComponent(bookSamples[1]);
      if (!findBook(id)) { json(res, 404, { error: `书 ${id} 未登记` }); return; }
      const P = pathsFor(id);
      const pct = (url.searchParams.get("pct") ?? "5,30,55,80").split(",").map(Number).filter((x) => x > 0 && x <= 100);
      const stored: any = existsSync(P.params) ? JSON.parse(readFileSync(P.params, "utf-8")) : {};
      const fx: Fx = { ...FX_DEFAULTS, contrast: stored.contrast ?? 100, denoise: stored.denoise ?? 0, sharpen: stored.sharpen ?? 0 };
      const total = await pdfPageCount(P.source);
      const pages = [...new Set(pct.map((x) => Math.min(total, Math.max(1, Math.round((x / 100) * total)))))];
      const results = await renderPagesToBuffers(P.source, pages, 1, fx);
      json(res, 200, {
        fx, total,
        samples: results.map((r) => ({ page: r.page, src: "data:image/png;base64," + Buffer.from(r.png).toString("base64") })),
      });
      return;
    }
    const bookVersions = p.match(/^\/api\/books\/([^/]+)\/versions$/);
    if (bookVersions) {
      const id = decodeURIComponent(bookVersions[1]);
      if (!findBook(id)) { json(res, 404, { error: `书 ${id} 未登记` }); return; }
      const vdir = path.join(pathsFor(id).dir, "versions");
      if (bookVersions[0].endsWith("/versions") && req.method === "GET") {
        mkdirSync(vdir, { recursive: true });
        const list = readdirSync(vdir).filter((f) => f.endsWith(".json")).sort().map((f) => {
          const j = JSON.parse(readFileSync(path.join(vdir, f), "utf-8"));
          return { file: f, v: j.v, label: j.label, ts: j.ts, blocks: j.blocks, done: j.done };
        });
        json(res, 200, list.reverse());
        return;
      }
      if (bookVersions[0].endsWith("/versions") && req.method === "POST") {
        const body = await readBody(req);
        if (body.graph) {
          // 保存语义（Ctrl+S）：工作台当前状态既存版、也落盘块图。
          // 落盘前提 = 工作台不是陈旧的：baseVersion 与块图现版本对账，对不上拒收（409）——
          // 否则陈旧产物会把回放/恢复推进过的块图整份倒灌回去。拒绝时本地裁决不丢，可导出日志走回放。
          const inflight = inflightOf(id);
          if (inflight) { json(res, 400, { error: `任务在途（${inflight.behavior}）会改写块图 —— 完成后再存版` }); return; }
          const P0 = pathsFor(id);
          const cur = readGraphVersion(P0.graph);
          if (cur === null || body.baseVersion !== cur) {
            json(res, 409, { error: `工作台已过期 —— 你打开的产物基于块图 v${body.baseVersion ?? "?"}，现在已是 v${cur ?? "?"}。未落盘裁决没丢：在工作台按 S 导出裁决日志，放入该书 inbox/ 回书架回放` });
            return;
          }
          const g = body.graph;
          g.version = cur; // saveGraph 统一 +1
          saveGraph(P0.graph, g);
        }
        json(res, 200, { ...snapshot(id, body.label), graphVersion: readGraphVersion(pathsFor(id).graph) });
        return;
      }
    }
    const bookRestore = p.match(/^\/api\/books\/([^/]+)\/versions\/([^/]+)\/restore$/);
    if (bookRestore && req.method === "POST") {
      const id = decodeURIComponent(bookRestore[1]);
      if (!findBook(id)) { json(res, 404, { error: `书 ${id} 未登记` }); return; }
      const inflight = inflightOf(id);
      if (inflight) { json(res, 400, { error: `任务在途（${inflight.behavior}）—— 完成后再恢复版本` }); return; }
      const vf = path.join(pathsFor(id).dir, "versions", path.basename(decodeURIComponent(bookRestore[2])) + ".json");
      if (!existsSync(vf)) { json(res, 404, { error: "版本不存在" }); return; }
      const snap = JSON.parse(readFileSync(vf, "utf-8"));
      const P = pathsFor(id);
      const g = snap.graph;
      g.version = readGraphVersion(P.graph) ?? g.version - 1; // saveGraph 统一 +1：恢复也是一次推进，不回退版本号
      saveGraph(P.graph, g); // 原子恢复
      json(res, 200, { ok: true, restored: snap.v });
      return;
    }
    const bookDelete = p.match(/^\/api\/books\/([^/]+)\/delete$/);
    if (bookDelete && req.method === "POST") {
      // 软删除：登记薄打标，数据与产物一概不动
      const id = decodeURIComponent(bookDelete[1]);
      const books = loadRegistry();
      const meta = books.find((x) => x.id === id);
      if (!meta) { json(res, 404, { error: `书 ${id} 未登记` }); return; }
      meta.deletedAt = new Date().toISOString();
      saveRegistry(books);
      json(res, 200, { ok: true });
      return;
    }
    const bookTextLayer = p.match(/^\/api\/books\/([^/]+)\/textlayer$/);
    if (bookTextLayer && req.method === "GET") {
      const id = decodeURIComponent(bookTextLayer[1]);
      const meta = findBook(id);
      if (!meta) { json(res, 404, { error: `书 ${id} 未登记` }); return; }
      json(res, 200, { hasText: await hasTextLayer(pathsFor(id).source) });
      return;
    }
    const bookRegions = p.match(/^\/api\/books\/([^/]+)\/regions$/);
    if (bookRegions) {
      const id = decodeURIComponent(bookRegions[1]);
      if (!findBook(id)) { json(res, 404, { error: `书 ${id} 未登记` }); return; }
      const rf = path.join(pathsFor(id).dir, "regions.json");
      if (req.method === "GET") {
        json(res, 200, existsSync(rf) ? JSON.parse(readFileSync(rf, "utf-8")) : { bands: [] });
        return;
      }
      if (req.method === "POST") {
        const body = await readBody(req);
        writeFileSync(rf, JSON.stringify({ bands: body.bands ?? [] }, null, 2), "utf-8");
        json(res, 200, { ok: true });
        return;
      }
    }
    const bookVerdicts = p.match(/^\/api\/books\/([^/]+)\/verdicts$/);
    if (bookVerdicts && req.method === "POST") {
      // 工作台裁决日志直存：http 源下导出走这里（落进该书 inbox/，回放器消费），
      // 不再赌浏览器下载是否落盘；写的是收发箱不是块图，唯一写者纪律不变。
      const id = decodeURIComponent(bookVerdicts[1]);
      if (!findBook(id)) { json(res, 404, { error: `书 ${id} 未登记` }); return; }
      const body = await readBody(req);
      const text = typeof body.text === "string" ? body.text : "";
      if (!text.trim()) { json(res, 400, { error: "日志为空" }); return; }
      const inbox = pathsFor(id).inbox;
      mkdirSync(inbox, { recursive: true });
      const f = path.join(inbox, `adjudication-${Date.now()}.jsonl`);
      writeFileSync(f, text.endsWith("\n") ? text : text + "\n", "utf-8");
      json(res, 200, { ok: true, file: path.basename(f) });
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
    if (e instanceof UserError) { json(res, 400, { error: e.message }); return; }
    // 意外 = 真 bug：栈留服务进程控制台，回给人一句不含糊的话
    console.error(`[server] ${req.method} ${p} 意外失败 ——`);
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: "服务端意外错误（详情见服务进程控制台）" });
    else res.end();
  }
});

function findBook(id: string): BookMeta | undefined {
  return loadRegistry().find((b) => b.id === id);
}

// 静态：只服务 library/ 内的文件（页图、工作台），防目录穿越
function serveLibrary(rel: string, res: import("node:http").ServerResponse): void {
  const root = libraryRoot();
  const full = path.normalize(path.join(root, decodeURIComponent(rel)));
  if (!full.startsWith(root) || !existsSync(full) || !statSync(full).isFile()) {
    res.writeHead(404); res.end("not found"); return;
  }
  res.writeHead(200, { "content-type": MIME[path.extname(full)] ?? "application/octet-stream" });
  res.end(readFileSync(full));
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`bookflow 书架 → http://127.0.0.1:${PORT}/`);
});
