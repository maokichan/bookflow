#!/usr/bin/env node
// 用 Typst 编译受控测试书 → library/test-book/source.pdf（测试书也是注册表里的一本书）
// Typst 二进制优先复用 book/tools/typst.exe（便携、即删即卸），其次 PATH。
import { spawnSync } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "library", "test-book");
const OUT_PDF = path.join(OUT_DIR, "source.pdf");
const CANDIDATES = [
  path.join(ROOT, "..", "book", "tools", "typst.exe"),
  "typst",
];

mkdirSync(OUT_DIR, { recursive: true });
const typst = CANDIDATES.find((c) => (c.includes("\\") ? existsSync(c) : true));
if (!typst) {
  console.error("未找到 typst（book/tools/typst.exe 或 PATH）");
  process.exit(1);
}
const r = spawnSync(typst, ["compile", "--root", path.join(ROOT, "testbook"),
  path.join(ROOT, "testbook", "main.typ"), OUT_PDF, "--font-path", "C:\\Windows\\Fonts"],
  { stdio: "inherit" });
if (r.status !== 0 || !existsSync(OUT_PDF)) {
  console.error("typst 编译失败");
  process.exit(r.status ?? 1);
}
console.log("OK", OUT_PDF);
