# bookflow —— 书稿流水线 MVP

PDF 书稿从入手到成书的全程工作流，最小可用版。架构与术语见
[`../book/书稿流水线架构.md`](../book/书稿流水线架构.md)（块图 / 状态机 / 三域检查 / 策略位）。

## 栈

全 JS/TS（Node ≥24 原生跑可擦除 TS，零构建），依赖仅 `pdfjs-dist`（钉 4.8.69，与 TuRead 同线）+ `@napi-rs/canvas`。
设计原则：**块图是唯一事实源，回放器是唯一写者**；工作台无持久状态，人的动作只落在 append-only 裁决日志里。

## 命令

```
npm run testbook   # 生成受控测试书（Typst，book/tools/typst.exe）
npm run extract    # S0+S1：文本层 → 行 → 分型 → 段落重组 → data/blockgraph.json
                   #   ⚠ 默认源是 data/source/test-book.pdf（29 块）！
                   #   真实科目：node src/extract.ts <pdf路径> <书名>
npm run render     # 页图 → data/pages/pNNN.png（工作台对照用）
npm run export     # 工作台导出 → workbench/workbench.html（数据内联单文件）
npm run replay     # 裁决日志回放：inbox/*.jsonl → 块图状态推进（唯一写者）
npm run smoke      # 端到端冒烟测试（⚠ 会把 data/ 重置为测试书，跑完需重建科目现场）
```

## 文档

- [`MAP.md`](MAP.md) —— 项目地图（红线 / 文档索引，模型会话入口）
- [`TODO.md`](TODO.md) —— 唯一待办清单
- [`../book/书稿流水线架构.md`](../book/书稿流水线架构.md) —— 架构与宪法（上位文档）
- [`交接文档.md`](交接文档.md) —— 冻结快照（2026-10-04 交接用，不再维护）

## 人工校对 #1 的操作环

1. `node src/extract.ts data/source/real-01-baudrillard.pdf 为何一切尚未消失 && npm run render && npm run export`
2. 浏览器打开 `workbench/workbench.html`（file:// 直开）
3. 键盘流：J/K 移动 · E 改文（Enter 提交，IME 安全）· G 盖章（原文已定）· Y 退回 · T 改型 · I 缩放 · , . 翻页 · S 导出日志 · Tab 切箱
4. 下载的 `adjudication-*.jsonl` 放入 `inbox/`，`npm run replay` → 块图推进
5. 回放后重新 `npm run export`，工作台即反映新状态

## MVP 已实现 / 未实现

已实现：块图模型（五类分型 + 未分型态、七级状态机、历史与守恒字段）、
文本层抽取（页眉页脚跨页聚类、大字号结构块、底部小字注释块、段落重组双信号：行距×1.3 + 首行缩进、
上标锚点字形丢弃并计数）、S2 清洗槽位（CJK 伪空格归一、拆散数字并回、标点空格归一——
机械规则，实测本书 320 块删 3090 噪声字符）、页图渲染、三视图工作台（台阶分箱 / 图文锚点对照 / 键盘裁决）、
裁决日志 + 回放器（前置状态校验，非法动作拒绝并报告）。

未实现（对应架构策略位，逐个点亮）：扫描件 OCR 腿、云端任何调用、翻译（S3）、
三域机器检查（S5）、结构重声明（吸收/派生/升降级）、锚定支流块的锚点配对、
File System Access API 直写（当前为下载-投递模式）。

## 已知边界（MVP 有意取舍）

- 块为页局部：跨页段落按页拆成两块，#1 人工可并（将来 S3 结构重声明接管）
- 加粗不进块图（pdfjs 文本层字体映射不可靠，等 OCR/重排阶段再看）
- 页眉判定阈值 ≥2 页（短书可触发；长书自动更稳）
- 抽取只信文本层 PDF；扫描件等 OCR 策略位点亮后接入
