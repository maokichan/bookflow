# bookflow —— 书稿流水线 MVP

PDF 书稿从入手到成书的全程工作流，最小可用版。架构与术语见
[`book/书稿流水线架构.md`](book/书稿流水线架构.md)（块图 / 状态机 / 三域检查 / 策略位）。

## 栈

全 JS/TS（Node ≥24 原生跑可擦除 TS，零构建），依赖仅 `pdfjs-dist`（钉 4.8.69，与 TuRead 同线）+
`@napi-rs/canvas`（渲染）+ `sharp`（前级图像处理）。
设计原则：**块图是唯一事实源，回放器是唯一写者**；工作台的裁决先落本地、Ctrl+S 保存时随版本一并落盘。

## 命令

一切工具按书寻址：`--book <id>`（书号在 `library/index.json` 登记）。

```
npm run app       # 书架 + 各书状态页 + 行为任务队列（本地服务，默认 127.0.0.1:8477）
npm run testbook  # 生成受控测试书（Typst，book/tools/typst.exe）
npm run extract   # S0+S1：文本层 → 行 → 分型 → 段落重组 + S2 清洗 → 该书 blockgraph.json
                  #   （块图已含人工裁决时拒绝重抽；--force 显式越权）
npm run render    # 页图 → 该书 pages/pNNN.png
npm run export    # 工作台导出 → 该书 workbench.html（数据内联单文件）
npm run replay    # 裁决日志回放：该书 inbox/*.jsonl → 块图状态推进（唯一写者）
npm run smoke     # 端到端冒烟（跑在测试书自己的目录里，不碰真实科目）
# 例：npm run export -- --book test-book
```

## 文档

- [`MAP.md`](MAP.md) —— 项目地图（红线 / 文档索引，模型会话入口）
- [`TODO.md`](TODO.md) —— 唯一待办清单
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) —— 程序架构：书籍状态管理 / 功能层级 / 行为 / 产物溯源 / 队列
- [`book/书稿流水线架构.md`](book/书稿流水线架构.md) —— 架构与宪法（上位文档，随 book 项目收养入本仓库目录）

## 人工校对 #1 的操作环

日常走书架：`npm run app` → 浏览器打开 `http://127.0.0.1:8477/` →
点开一本书 → 预处理（调参看采样，确定后解锁识别）→ 识别 → 校对（进工作台，
底部当前条目裁决，J/K/E/G/T/H/M/N 键盘流，Ctrl+S 保存）。
命令行等价：`npm run export -- --book pourquoi` 等按书寻址的命令。

## MVP 已实现 / 未实现

已实现（细节见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) 与 [`TODO.md`](TODO.md) 的 ✅ 记录）：
块图模型与状态机、文本层抽取（页眉页脚聚类 / 段落重组 / S2 机械清洗）、预处理阶段
（采样预览 + 滑杆参数 + 确定门控 + 注意力框区域 + 页图产物落盘）、页图渲染、
书籍状态管理（书架 / 流水线状态页 / 行为任务队列 / 版本管理 / 软删除）、
校对工作台（纸与桌布局 / 底部焦点条目 / 拼合 / 结构角色 / 注释符 / OCR 产物右栏）、
裁决日志 + 回放器（前置状态校验，非法动作拒绝并报告）、
用户交互行为表（[`src/actions.ts`](src/actions.ts)：书级行为的封闭资格表，服务端执法、
书架同表画锁；块图版本单调递增，工作台存版按 baseVersion 对账，陈旧产物 409 拒收）。

未实现（对应架构策略位，逐个点亮）：扫描件 OCR 腿（本地 PaddleOCR ONNX 已拍板）、云端任何调用、
翻译（S3）、三域机器检查（S5）、结构重声明的派生/升降级（拼合已提前落地）、锚定支流块的锚点配对。

## 已知边界（MVP 有意取舍）

- 块为页局部：跨页段落按页拆成两块，#1 可拼合（M 键，声明式吸收；将来 S3 复用同一机制）
- 加粗不进块图（pdfjs 文本层字体映射不可靠，等 OCR/重排阶段再看）
- 页眉判定阈值 ≥2 页（短书可触发；长书自动更稳）
- 抽取只信文本层 PDF；扫描件等 OCR 策略位点亮后接入
