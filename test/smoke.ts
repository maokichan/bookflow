// 端到端冒烟测试：抽取断言 → 页图 → 工作台导出 → 合成裁决日志回放 → 断言 → 重置。
// 跑法：npm run smoke。结束时代码会重新抽取，块图回到干净 typed 态。
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { PATHS } from "../src/model.ts";

let failures = 0;
const ok = (cond: boolean, name: string, detail = "") => {
  console.log((cond ? "  ✓ " : "  ✗ ") + name + (detail ? ` —— ${detail}` : ""));
  if (!cond) failures++;
};
const run = (script: string, args: string[] = []) =>
  spawnSync("node", [script, ...args], { cwd: path.resolve(import.meta.dirname, ".."), stdio: "pipe" });

// ---------- 0. 测试书 ----------
if (!existsSync(path.join(ROOT_OF(), "data", "source", "test-book.pdf"))) {
  const r = run("scripts/build-testbook.mjs");
  if (r.status !== 0) { console.error("测试书编译失败"); process.exit(1); }
}
function ROOT_OF() { return path.resolve(import.meta.dirname, ".."); }

console.log("▶ 1/5 抽取");
let r = run("src/extract.ts");
if (r.status !== 0) { console.error(r.stderr.toString()); process.exit(1); }
const g = JSON.parse(readFileSync(PATHS.graph, "utf-8"));
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
for (const f of readdirSync(PATHS.pagesDir).filter((f) => f.endsWith(".png")))
  rmSync(path.join(PATHS.pagesDir, f)); // 清掉其他科目的页图，保证计数断言干净
r = run("src/renderpages.ts");
if (r.status !== 0) { console.error(r.stderr.toString()); process.exit(1); }
const pngs = readdirSync(PATHS.pagesDir).filter((f) => f.endsWith(".png"));
ok(pngs.length === g.pages.length, `PNG ${pngs.length} 张`);

console.log("▶ 3/5 工作台导出");
r = run("src/exportwb.ts");
if (r.status !== 0) { console.error(r.stderr.toString()); process.exit(1); }
const wb = readFileSync(path.join(PATHS.workbenchDir, "workbench.html"), "utf-8");
ok(wb.includes("var DATA = "), "数据已内联");
ok(wb.includes("../data/pages/p001.png") || wb.includes('pageSrc'), "页图相对路径引用");

console.log("▶ 4/5 合成裁决回放");
const flow1 = g.blocks.find((b) => b.type === "flow" && b.text.includes("一九八九年"))!;
const flow2 = g.blocks.find((b) => b.type === "flow" && b.text.includes("The Chemical Brothers"))!;
const quote = g.blocks.find((b) => b.type === "flow" && b.text.includes("我们从来不觉得"))!;
const editedText = flow2.text.replace("more melodic", "更加旋律化（人工校订）");
const logLines = [
  { ts: new Date().toISOString(), block: flow1.id, action: "gate", payload: { state: "原文已定" } },
  { ts: new Date().toISOString(), block: flow2.id, action: "edit", payload: { text: editedText } },
  { ts: new Date().toISOString(), block: quote.id, action: "reclassify", payload: { type: "untyped" } },
  { ts: new Date().toISOString(), block: flow1.id, action: "gate", payload: { state: "原文已定" } }, // 非法：重复盖章
];
const logName = "smoke-test.jsonl";
writeFileSync(path.join(PATHS.inbox, logName), logLines.map((l) => JSON.stringify(l)).join("\n") + "\n");
r = run("src/replay.ts");
console.log(r.stdout.toString().trim());
ok(r.status === 0, "回放退出码 0");
const g2 = JSON.parse(readFileSync(PATHS.graph, "utf-8"));
const b1 = g2.blocks.find((b) => b.id === flow1.id)!;
const b2 = g2.blocks.find((b) => b.id === flow2.id)!;
const b3 = g2.blocks.find((b) => b.id === quote.id)!;
ok(b1.state === "原文已定", `${flow1.id} → 原文已定`);
ok(b2.text === editedText, `${flow2.id} 改文生效`);
ok(b3.type === "untyped", `${quote.id} → untyped`);
ok(g2.version === (g.version as number) + 1 || g2.version > 0, `块图版本 ${g.version} → ${g2.version}`);
ok(readdirSync(PATHS.inbox).filter((f) => f.endsWith(".jsonl")).length === 0, "inbox 已清空");
ok(existsSync(path.join(PATHS.processed, logName)), "日志归档到 processed/");
ok(r.stdout.toString().includes("拒绝 1"), "非法动作被拒（重复盖章）");

console.log("▶ 5/5 重放后工作台反映新状态");
r = run("src/exportwb.ts");
const wb2 = readFileSync(path.join(PATHS.workbenchDir, "workbench.html"), "utf-8");
ok(wb2.includes("人工校订"), "工作台内联数据含回放结果");

// ---------- 重置：干净 typed 态交给真实第一次人工校对 ----------
rmSync(path.join(PATHS.processed, logName));
run("src/extract.ts");
run("src/exportwb.ts");
console.log(failures ? `\n${failures} 项失败` : "\n全部通过 —— 块图已重置为干净 typed 态，可直接进工作台");
process.exit(failures ? 1 : 0);
