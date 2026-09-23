# Fork 变更清单（按功能域）与重做指南

> 交接对象：在全新 upstream master 上重做 fork 改动的接手 agent / 开发者。
>
> - upstream：`https://github.com/siteboon/claudecodeui.git`；fork：`https://github.com/xingcheng1061/claudecodeui.git`
> - 行数为 fork 相对 upstream（`6c51fcaa`）的**净变更行数**（增删合计），来源 `git diff upstream/main HEAD --stat`。总计约 +6000/−700 行、95 个文件。
> - 重做环境：`../claudecodeui-fresh`（upstream 最新 master 干净克隆），基线见其 `SETUP-BASELINE.md`。
> - 状态标记：✅ 可直接重做 ｜ ⚠️ 需改方案或融合 ｜ ❌ 已回退/被取代，不要重做

---

## 一、Bug 修复（12 项）

### 1. CLI 路径解析：非 ASCII 用户路径被打碎 ✅

- **问题**：`where.exe` 按控制台代码页输出，按 UTF-8 读取会把 `C:\Users\星辰\...` 打碎，找不到 claude CLI。
- **文件**：`server/shared/claude-cli-path.ts`（±135）；`server/shared/tests/claude-cli-path.test.ts`（±101）
- **方案**：进程内遍历 PATH（目录序 × PATHEXT 序），空扩展名优先，去重。重做前确认 upstream 是否已自行修复。

### 2. 流式输出域：四类显示错乱 ✅

- **问题**：① reasoning 不实时、整段吐；② 多会话/多子 agent 增量拼进同一字符串互相串线；③ 思考块流式期间被重挂、展开丢失；④ 聚焦后流式更新把读者拽回卡片。
- **文件**：
  - `claude-runtime.provider.js`（±895，**横跨多个功能域**；本项占 delta 映射：`includePartialMessages`、`content_block_delta → stream_delta/thinking_delta`、`content_block_stop → stream_end`，两种事件形状都处理）
  - `src/modules/chat/hooks/useChatRealtimeHandlers.ts`（±152：delta 按 sessionId 分桶、子 agent delta 不渲染）
  - `src/modules/chat/hooks/useChatMessages.ts`（±103，与功能 B1 共用；本项占行身份稳定）
  - `src/modules/chat/transcript/ChatMessagesPane.tsx`（±50：聚焦滚动 token 一次性消费）
  - `src/modules/chat/transcript/Reasoning.tsx`（±33）
  - 测试：`thinkingStream`(99)、`thinkingCollapse`(94)、`streamingRowIdentity`(88)、`liveSubagentGrouping`(101)
- **注意**：upstream 也改了 `useChatRealtimeHandlers`（task_status 折叠），融合结果可参照合并提交 `dd0b388c`。
- **⚠️ 因果标注**：本项四个子项因果不同——①是流式**修复**的 bug；**②③④是流式功能激活的 bug**（upstream 的显示管线为整段消息设计：单缓冲、无行身份、滚动意图即时执行——整段更新下这些设计无副作用；token 级流式让三个假设同时失效）。因此**流式与 ②③④ 的三项配套修复必须捆绑为一个不可拆分的单元**：只移植流式不移植配套，上线即复现这三个 bug。其余 bug 域（路径/窗口/usage/判停/收杀/Windows/派发/终止/SW）与流式无因果。

### 3. 上下文窗口分母失真：1M 模型显示"永远快满" ✅

- **文件**：`server/modules/providers/shared/context-window.ts`（+116 新：按模型学习窗口，优先级 env > 模型学习值 > 最近学习值 > 160000）；`context-window.test.ts`（+103）；`provider-token-usage.service.ts`（±11）；`claude-runtime.provider.js` 的一部分
- **数据来源**：每轮 `result.modelUsage[<model>].contextWindow`。

### 4. 全 0 usage 清零计数器 + 压缩感知 ✅

- **问题**：`/compact` 等本地命令产生全 0 usage 清零计数；压缩轮预算错乱。
- **文件**：`claude-runtime.provider.js` 的一部分（`isEmptyUsage()` 全 0 跳过；压缩轮 latch + `post_tokens` 作新预算）。
- **注意**：`compact_boundary` SDK 无类型，防御式读两种形状；与 upstream tracker 有重叠，二选一。

### 5. 子 agent 卡片"永远转圈" ⚠️ 已被 upstream 取代

- 我们的方案（transcript mtime 静默窗口）合并时删除；upstream 的 `launchedByLiveRun`（进程感知）更准且已就位。重做动作：无。

### 6. abort 不杀进程组：后台任务成孤儿 ✅

- **问题**：`interrupt()` 只停当前 turn，后台子 agent 继续跑/花钱。
- **文件**：`claude-runtime.provider.js` 的一部分（abort 路径加 `session.instance.close?.()` SIGKILL 进程组，在 interrupt + 宽限期之后）。

### 7. run 收尾残留任务卡"运行中" ✅（部分被 upstream tracker 取代）

- **问题**：进程结束/崩溃时残留任务永不上报，卡片永远转圈。
- **文件**：`claude-runtime.provider.js` 的一部分（`settleRunningTasks` 把残留任务发 `subagent_update {status:'stopped'}`，正常结束与异常两路径）。

### 8. Shell 终端隐藏后尺寸错乱（cols:0 发给后端）✅

- **文件**：`src/modules/shell/hooks/useShellTerminal.ts`（+13：两处 clientWidth===0 guard）。

### 9. Windows 专项：temp 写保护缺失 + symlink 测试 ✅

- **问题**：upstream 假设 temp 目录在 `FORBIDDEN_WORKSPACE_PATHS`——POSIX 成立，Windows 的 `os.tmpdir()` 不在；且 Windows 建 symlink 需管理员权限，测试 EPERM。
- **文件**：`server/shared/utils.ts`（+5：`os.tmpdir()` 入禁止清单）；`server/shared/tests/read-only-roots.test.ts`（±28：EPERM skip）；`server/modules/file-tree/tests/file-tree.service.test.ts`（±14：同）
- **说明**：upstream 贡献者环境是 macOS/Linux 的 Windows 盲区，纯净版这 4 个测试必挂。

### 10. 队列派发失败消息蒸发 ✅

- **问题**：派发器 claim 后抛错，消息已清空但未发送——静默丢失。
- **文件**：`scheduled-message-dispatcher.service.ts`（±56 中的一部分：try/catch → 还原重试）。

### 11. 终止按钮无法终止 held-open 残留进程 ✅

- **问题**：`chat.abort` 在 registry 无 running run 时拒绝——run 已 complete 但进程残留时前端点终止无效。
- **文件**：`chat-websocket.service.ts`（±292 中的一部分：run 不在跑时 best-effort 调 `runtime.abort(session.provider)` 杀存留进程，不发终态帧）。
- **关联**：静默看门狗已按用户决策移除，卡死恢复统一走终止按钮。

### 12. Service Worker 无缓存请求返回 undefined ✅

- **文件**：`public/sw.js`（±26：fetch 失败且无缓存答 504）。

---

## 二、功能新增（8 项）

### 1. 独立子 agent 面板体系（最大投入）⚠️ 需先做设计决策

- **内容**：子 agent 列表独立端点（与转写分页无关）；行点击聚焦卡片（缺失可全量加载）；内联时间线；聚焦跳转；叙述 markdown 渲染；渲染上限。
- **文件**：`SubagentsPanel.tsx`（+437 新）；`useSessionSubagents.ts`（±186）；`SubagentPanel.tsx`（±225）；`useChatMessages.ts`（±103 部分：`mergeSubagentState`）；`subagentStatus.ts`（+70 新）；`SubagentFocusContext.tsx`（+28 新）；`liveSubagentGrouping.test`(101)、`subagentStatus.test`(36)；`sessions.service.ts`（±61 部分：`fetchSubagentTranscript`+`listSessionSubagents`）；`provider.routes.ts`（±51 部分：两个端点）；`claude-sessions.provider.ts`（±288 部分：转写读取+卡片构造）
- **⚠️ 决策点**：upstream 有自己的 `SubagentPanel/SubagentTimeline/WorkflowPanel`（task_status 协议 + workflow journal）。先定以哪套为准再动手；融合结果参照 `dd0b388c`。

### 2. 队列消息"立即发送"（注入活进程）⚠️

- **内容**：run 进行中，队列消息 push 进活 CLI stdin，当前 turn 结束立即执行；complete 不扣押。
- **文件**：`claude-runtime.provider.js`（±895 部分：`push`/`heldPromptStreams`/`injectIntoRunningClaudeTurn`）；`chat-websocket.service.ts`（±292 部分：`chat.queue.inject` 帧）；`interfaces.ts`（±42 部分）、`provider-runtime.service.ts`（±47 部分）；`QueuedMessageCard.tsx`（±21）、`ChatComposer.tsx`（+4）、`ChatInterface.tsx`（±107 部分）
- **⚠️ 已知局限**：push 成功不保证 CLI 处理（结果可能不来）——已按"只扣进程不扣 complete"缓解。

### 3. 单写者锁（并发写入保护）✅

- **内容**：run 结束但进程存活时，`dispatchRun` 拒绝 spawn 第二个 CLI 进程，改服务端代为排队 + 广播；防双写污染转写。
- **文件**：`chat-websocket.service.ts`（±292 部分：`isSessionProcessAlive` 检查 + `HELD_OPEN_BUSY_ERROR`）；`provider-runtime.service.ts`（±47 部分）；`interfaces.ts`（±42 部分）
- **注意**：与 upstream `hasBackgroundWork` 会话保护共存。

### 4. 上下文窗口自适应 ✅（兼具 bug #3 性质）

- **文件**：同 bug #3。

### 5. /help 列出 CLI 原生命令（19+ 条）✅

- **文件**：`commands.routes.ts`（±58）；`useSlashCommands.ts`（±24：菜单插入不执行，避开 execute 重提交死循环）。

### 6. 目录选择器递归搜索 ✅

- **内容**：≥2 字符防抖；后端受限递归（深度 4 / 结果 30 / 访问 4000，跳过隐藏与重目录），根 = 当前浏览目录；结果带全路径。
- **文件**：`file-tree.service.ts`（±99 部分：`searchWorkspaceFolders`）；`file-tree.routes.ts`（+7）；`FolderBrowserModal.tsx`（±110）；`WorkspacePathField.tsx`（+4）；`workspaceApi.ts`（+23）；`api.ts`（+11 部分）

### 7. 文件树侧栏 + 可拖分栏 ✅

- **文件**：`FilesSidebar.tsx`（+98 新）；`useResizableWidth.ts`（+123 新）；`WorkspaceMain.tsx`（±95）；`WorkspaceHeader.tsx`（+6）；`WorkspaceTabs.tsx`（±11）；`useProjectsState.ts`（±9）；`WorkspaceTitle.tsx`（−4）
- **⚠️ 注意**：同批曾引入 Shell 常驻挂载，已回退——重做分栏时不要把 Shell 改成 hidden-not-unmounted。

### 8. 模型目录本地快照 ✅

- **内容**：`models.json` 快照（`bin/refresh-models.mjs` 手动生成）+ `loadModelsFromFile()`（快照 → 内置目录两层）。
- **文件**：`claude-models.provider.ts`（±82）；`bin/refresh-models.mjs`（+89 新）；`refresh-models.sh`（+5 新）
- **❌ 不要重做**：运行时 spawn claude 探测 supportedModels（提交 `285e3747`）——读得不准，已回退。

---

## 三、文档与杂项

- 架构文档：`docs/architecture/01-websocket-transport.md`(±4)、`02-realtime-stream.md`(±34)、`06-tool-view.md`(±56)、`README.md`(±5)、`providers/README.md`(+33)、`websocket/README.md`(±6)
- 运行笔记：`已知问题以及待优化项.md/.json`(+136)
- 类型：`server/shared/types.ts`(±27)、`src/shared/types.ts`(±27)、`server/shared/interfaces.ts`(±42)、`server/shared/utils.ts`(+5)
- 本文件：`FORK-CHANGES.md`

## 四、已回退 / 已被取代（不要重做）

| 变更 | 原提交 | 状态 |
|---|---|---|
| 模型目录运行时探测 | `285e3747` | ❌ 读得不准，`dee12fae` 回退；保留快照方案 |
| 子 agent mtime 静默窗口 | `dee12fae` 内 | ⚠️ upstream `launchedByLiveRun`（进程感知）取代 |
| 注入扣押 complete（计数器） | `a21b1d02`/`f105e0a7` 内 | ❌ 设计缺陷（push 不保证结果），`349dcac5` 修正为只扣进程 |
| Shell 标签 CSS 隐藏不卸载 | `f1b2d515` 内 | ❌ PTY 常驻，`fa4cff25` 回退为条件挂载 |
| 静默看门狗（run 启动武装天花板） | `349dcac5` 内 | ❌ 用户决策移除：卡死靠前端终止按钮（终止已覆盖所有状态） |

## 五、已知遗留（未修，重做时再决策）

1. **注入可靠性**：push 成功不保证 CLI 处理；结果不来时消息滞留 pending 队列，天花板触发后随流结束丢失。彻底方案：只在确认 CLI 空闲时注入，或接受丢失并在 UI 标注。
2. **SDK 流静默卡死**：run 中 CLI 完全静默 → 无 result；恢复靠前端终止按钮（已可用）。专用心跳看门狗（短上界主动 interrupt）被推迟。
3. **queue 单槽覆盖**（设计级）：第二条入队顶掉第一条且服务端无痕。方向：多行队列表 + 派发成功才删。
4. **终止按钮可见性**：`isProcessing` 才显示；held-open 卡死时前端无按钮（杀进程路径存在但需程序触发）。

## 六、重做环境与验证基线

环境：`e:/Codes_new/claudecodeui-fresh`（upstream 最新 master `6c51fcaa` 干净克隆，已 `npm install`，remotes：origin=upstream、fork=我们的 fork）。基线详见其 `SETUP-BASELINE.md`：

| 项 | 基线 |
|---|---|
| typecheck | 0 error |
| 服务端 `npm test` | 547 例 / 528 过 / **17 失败**（其中约 13 个会被本清单的 bug 修复治愈：temp 写保护 ×2、hold 时序抖动 ×2、symlink EPERM ×2，及既有的 agent flake/credentials 等） |
| 前端 `npx vitest run` | 78 文件 / 526 例全过 |

## 七、重做顺序与环境坑

**依赖顺序**：bug1 → 功能4(context-window) → bug2(流式) → 功能1(面板，先决策) → 功能5 → bug6/7 → 功能2/3(注入+锁，用修正语义) → 功能6 → 功能7(去掉 shell 常驻) → bug9/10/11/12 → 文档。

**环境坑（全部实测）**：
- commitlint：正文每行 ≤100 字符（PowerShell 多行信息用反引号 n 拼进单个 `-m`）
- lint-staged v16：把 `git stash create` 的 stdout 当 hash——不要留"已修改未暂存"的 LF 文件，否则 `fatal: Needed a single revision` 挡住所有提交
- PowerShell 命令层的长命令里 `&&` 会被吞——批量改代码用编辑工具，不要用 shell here-string
- `oxlint` 0 warning 基线；`npm test` 是 node:test（每文件独立进程）
- zh-CN i18n 没有 `folderBrowser` 段属正常（回退 en 是既有约定）
- models.json：改模型后手动跑 `refresh-models.sh`，不要放启动流程
- 本仓库历史上有"重建历史"操作：对照提交用 patch 内容比对，不要假设提交号两边一致
