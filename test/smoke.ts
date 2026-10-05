// 端到端冒烟测试：测试书抽取断言 → 页图 → 工作台导出 → 合成裁决日志回放 → 断言 → 清理。
// 测试书是注册表里的一本书（id=test-book），与真实科目互不可见 —— 不再有"冒烟重置真实现场"的坑。
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, readdirSync, rmSync, mkdirSync } from "node:fs";
import path from "node:path";
import { ROOT, joinParaText } from "../src/model.ts";
import { LIBRARY, loadRegistry, saveRegistry, pathsFor, deriveStage } from "../src/library.ts";

const BOOK = "test-book";
const P = pathsFor(BOOK);
let failures = 0;
const ok = (cond: boolean, name: string, detail = "") => {
  console.log((cond ? "  ✓ " : "  ✗ ") + name + (detail ? ` —— ${detail}` : ""));
  if (!cond) failures++;
};
const run = (script: string, args: string[] = []) =>
  spawnSync("node", [script, "--book", BOOK, ...args], { cwd: ROOT, stdio: "pipe" });

// ---------- 0. 测试书入册 ----------
const registry = loadRegistry();
if (!registry.some((b) => b.id === BOOK)) {
  registry.push({ id: BOOK, title: "测试书", createdAt: new Date().toISOString() });
  saveRegistry(registry);
}
if (!existsSync(P.source)) {
  const r = spawnSync("node", ["scripts/build-testbook.mjs"], { cwd: ROOT, stdio: "pipe" });
  if (r.status !== 0) { console.error(r.stderr.toString()); console.error("测试书编译失败"); process.exit(1); }
}
rmSync(P.graph, { force: true });
rmSync(P.pagesDir, { recursive: true, force: true });

console.log("▶ 1/5 抽取");
let r = run("src/extract.ts");
if (r.status !== 0) { console.error(r.stderr.toString()); process.exit(1); }
const g = JSON.parse(readFileSync(P.graph, "utf-8"));
ok(g.pages.length >= 3, `页数 ${g.pages.length}`);
const byType = (t: string) => g.blocks.filter((b) => b.type === t);
ok(byType("structure").length === 5, `结构块 5（实得 ${byType("structure").length}）`);
const titles = byType("structure").map((b) => b.text).join("|");
ok(["进入行星尘埃", "我们从哪里开始", "放下把铲子的人", "出发去海滩之前", "尾声：致最初的后排"].every((t) => titles.includes(t)), "五个章题齐全");
ok(byType("furniture").length === 6, `附着块 6（3 页眉 + 3 页码，实得 ${byType("furniture").length}）`);
const flows = byType("flow").map((b) => b.text);
ok(flows.some((t) => t.includes("The Chemical Brothers") && t.includes(" melodic")), "英文跨行拼接保空格");
ok(flows.some((t) => t.includes("磁带机的暂停键")), "中文跨行拼接无空格");
ok(flows.some((t) => t.includes("Tom Rowlands 出生于")), "中西文边界空格");
ok(!flows.some((t) => /。1|1他们/.test(t)), "脚注上标标记未混入正文");
ok(byType("annotation").length === 1 && byType("annotation")[0].text.startsWith("采样机型号"), "脚注体成块且编号字形已弃");
ok(flows.length === 17, `流转块 17（实得 ${flows.length}）`);
const ids = new Set(g.blocks.map((b) => b.id));
ok(ids.size === g.blocks.length, "块 ID 唯一");
ok(g.blocks.every((b) => b.state === "typed"), "全部 typed");

console.log("▶ 2/5 页图");
r = run("src/renderpages.ts");
if (r.status !== 0) { console.error(r.stderr.toString()); process.exit(1); }
const pngs = readdirSync(P.pagesDir).filter((f) => f.endsWith(".png"));
ok(pngs.length === g.pages.length, `PNG ${pngs.length} 张`);
// 尺寸护栏：渲染出占位白图（曾因参数误读缩放为 NaN）在这里当场拦下
const dim = (f: string) => { const b = readFileSync(path.join(P.pagesDir, f)); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };
const [w1, h1] = dim("p001.png");
ok(w1 >= 600 && h1 >= 800, `页图尺寸 ${w1}×${h1}（scale2 应约 750×1170）`);

console.log("▶ 3/5 工作台导出");
r = run("src/exportwb.ts");
if (r.status !== 0) { console.error(r.stderr.toString()); process.exit(1); }
const wb = readFileSync(P.workbench, "utf-8");
ok(wb.includes("var DATA = "), "数据已内联");
ok(wb.includes('"pages/"') || wb.includes("PAGES_BASE"), "页图相对路径指向书内 pages/");

console.log("▶ 4/5 合成裁决回放");
const flow1 = g.blocks.find((b) => b.type === "flow" && b.text.includes("一九八九年"))!;
const flow2 = g.blocks.find((b) => b.type === "flow" && b.text.includes("The Chemical Brothers"))!;
const quote = g.blocks.find((b) => b.type === "flow" && b.text.includes("我们从来不觉得"))!;
const editedText = flow2.text.replace("more melodic", "更加旋律化（人工校订）");
// 拼合样本：书序相邻、未被其他动作触及的一对流转块
let mSrc: any, mTgt: any;
for (let i = 0; i < g.blocks.length - 1; i++) {
  const a = g.blocks[i], c = g.blocks[i + 1];
  if (a.type === "flow" && c.type === "flow" && a.state === "typed" && c.state === "typed"
    && ![flow1.id, flow2.id, quote.id].includes(a.id) && ![flow1.id, flow2.id, quote.id].includes(c.id)) {
    mSrc = a; mTgt = c; break;
  }
}
const mergedText = joinParaText(mSrc.text, mTgt.text);
const logLines = [
  { ts: new Date().toISOString(), block: flow1.id, action: "gate", payload: { state: "原文已定" } },
  { ts: new Date().toISOString(), block: flow2.id, action: "edit", payload: { text: editedText } },
  { ts: new Date().toISOString(), block: quote.id, action: "reclassify", payload: { type: "untyped" } },
  { ts: new Date().toISOString(), block: mSrc.id, action: "merge", payload: { absorb: mTgt.id } },
  { ts: new Date().toISOString(), block: flow1.id, action: "gate", payload: { state: "原文已定" } }, // 非法：重复盖章
];
const logName = "smoke-test.jsonl";
mkdirSync(P.inbox, { recursive: true });
writeFileSync(path.join(P.inbox, logName), logLines.map((l) => JSON.stringify(l)).join("\n") + "\n");
r = run("src/replay.ts");
console.log(r.stdout.toString().trim());
ok(r.status === 0, "回放退出码 0");
const g2 = JSON.parse(readFileSync(P.graph, "utf-8"));
const b1 = g2.blocks.find((b) => b.id === flow1.id)!;
const b2 = g2.blocks.find((b) => b.id === flow2.id)!;
const b3 = g2.blocks.find((b) => b.id === quote.id)!;
const mS2 = g2.blocks.find((b) => b.id === mSrc.id)!;
const mT2 = g2.blocks.find((b) => b.id === mTgt.id)!;
ok(b1.state === "原文已定", `${flow1.id} → 原文已定`);
ok(b2.text === editedText, `${flow2.id} 改文生效`);
ok(b3.type === "untyped", `${quote.id} → untyped`);
ok(mS2.text === mergedText, `${mSrc.id} 拼合文本生效`);
ok(mT2.absorbedInto === mSrc.id, `${mTgt.id} 已标记吸收`);
ok(readdirSync(P.inbox).filter((f) => f.endsWith(".jsonl")).length === 0, "inbox 已清空");
ok(existsSync(path.join(P.processed, logName)), "日志归档到 processed/");
ok(r.stdout.toString().includes("拒绝 1"), "非法动作被拒（重复盖章）");

console.log("▶ 5/5 回放后工作台反映新状态 + 阶段推导");
r = run("src/exportwb.ts");
const wb2 = readFileSync(P.workbench, "utf-8");
ok(wb2.includes("人工校订"), "工作台内联数据含回放结果");
const stage = deriveStage(BOOK);
ok(stage.extracted && stage.rendered && stage.exported, `阶段推导齐全（${stage.blockCount} 块 / ${stage.pageCount} 页）`);
ok(stage.blockStates["原文已定"] === 1, `阶段状态含 1 个原文已定（实得 ${stage.blockStates["原文已定"] ?? 0}）`);

// ---------- 清理：测试书的裁决痕迹移除，块图回到干净 typed 态 ----------
rmSync(path.join(P.processed, logName));
run("src/extract.ts");
run("src/exportwb.ts");
console.log(failures ? `\n${failures} 项失败` : "\n全部通过 —— 测试书已重置，真实科目不受影响");
process.exit(failures ? 1 : 0);
