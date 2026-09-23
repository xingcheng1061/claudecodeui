# Fork 变更清单与重做指南

> 交接对象：在全新 upstream master 上重做 fork 改动的接手 agent / 开发者。
>
> 背景：本 fork（`origin`）在 upstream（`siteboon/claudecodeui`）基础上累积了 14 个自有提交。其中部分变更引入了 bug（注入机制的 complete 扣押、shell 常驻挂载等，下文逐条标注），决定**新建文件夹基于 upstream 最新 master 重做**。本文档逐条列出全部变更、每条的当前状态、以及重做时的注意事项。
>
> 基线事实：
> - 分叉点（merge-base）：`3ed3be5a`（feat(settings): close settings modal with escape and backdrop click #1164）
> - 已合并 upstream 至 `6c51fcaa`（feat(1188): let the sidebar be resized #1189），upstream/main 目前无新增
> - 我们的自有提交共 14 个（+合并提交 1 个），总计约 +6000/−700 行

---

## 一、变更总清单（按时间序，一条一条）

状态标记：✅ 可直接重做 ｜ ⚠️ 重做时需改方案或注意融合 ｜ ❌ 已回退/已被取代，**不要重做**

### 1. `41034a59` fix(claude): resolve the CLI path by walking PATH in-process ✅

- **文件**：`server/shared/claude-cli-path.ts`（新）、`server/shared/tests/claude-cli-path.test.ts`（新）
- **内容**：废弃 `where.exe` 查找 claude CLI（其输出按控制台代码页编码，按 UTF-8 读取会把 `C:\Users\星辰\...` 这类非 ASCII 安装路径打碎），改为进程内按目录序 × PATHEXT 序遍历 PATH，空扩展名优先（兼容 npm 的 POSIX shim），去重。
- **状态**：✅ Windows 环境必需。重做前先确认 upstream 是否已自行修复同类问题。

### 2. `39dae270` feat(chat): 流式 reasoning + 思考折叠 + 独立子 agent 面板 ⚠️

- **文件**：39 个，+3362/−152。核心：`server/modules/providers/list/claude/claude-runtime.provider.js`（includePartialMessages、content_block_delta→stream_delta/thinking_delta 映射）、`src/modules/chat/` 下 `useChatMessages.ts`、`SubagentPanel.tsx`、`SubagentsPanel.tsx`、`SubagentFocusContext.tsx`、`useSessionSubagents.ts`、子 agent 转写端点 `fetchSubagentTranscript`。
- **内容**：reasoning 实时流式（不再整段吐）、thinking 块默认折叠且行身份稳定（流式期间展开不被重挂）、独立子 agent 面板（列表来自独立端点，与转写分页无关；行点击聚焦卡片，缺失卡片可全量加载）。
- **状态**：⚠️ **重做时最大的融合点**。upstream 已有自己的 `SubagentPanel/SubagentTimeline/WorkflowPanel/BackgroundTasksStrip` + `task_status` 协议。本条的面板体系与其重叠但设计不同（我们的：独立列表端点 + 聚焦跳转 + 按需全量时间线；他们的：launch 行折叠 + workflow journal）。重做时需要先做一个设计决策：**以哪套面板为准**，然后只移植另一方的优点。流式映射部分（delta 映射、折叠）与 upstream 无冲突，可平移。

### 3. `6417075a` feat(claude): 上下文窗口学习 + forwardSubagentText + CLI 命令清单 ✅

- **文件**：`server/modules/providers/shared/context-window.ts`（新）、`claude-runtime.provider.js`、`provider-token-usage.service.ts`、`commands.routes.ts`。
- **内容**：
  - 按模型学习上下文窗口（`learnContextWindow/resolveContextWindow/learnContextWindowsFromResult`），来源 `result.modelUsage[<model>].contextWindow`，优先级：`CONTEXT_WINDOW` env > 模型学习值 > 最近学习值 > 160000。修复 1M 窗口模型按 160k 分母显示"永远快满"。
  - `sdkOptions.forwardSubagentText = true`：子 agent 的 text/thinking 实时进主流（带 parentToolUseId）。
  - `/help` 列出 CLI 原生命令（namespace `cli`），**不注册进命令面板**（面板命中会走 execute 重提交，/compact 会无限循环）。
- **状态**：✅ 可平移。`forwardSubagentText` 与 upstream 的 tracker 无冲突。

### 4. `a21b1d02` feat(claude): 注入 + run 收尾兜底 + abort 收杀 ⚠️（方案已修正，见 #13/#14）

- **文件**：`claude-runtime.provider.js`、`server/shared/interfaces.ts`、`provider-runtime.service.ts`、`chat-websocket.service.ts`、`QueuedMessageCard.tsx`、`ChatComposer.tsx`、`ChatInterface.tsx`。
- **内容**：
  - `createHeldPromptStream` 加 `push()`：向活着的 CLI stdin 推后续 turn（CLI stream-input 模式原生支持多 turn）。
  - 模块级 `heldPromptStreams` 注册表 + `injectIntoRunningClaudeTurn` 导出 + gateway 分发 + `chat.queue.inject` 帧 + 队列卡片「立即发送」按钮。
  - `settleRunningTasks`：run 结束时把残留任务逐个上报 `stopped`（现已部分被 upstream tracker 取代）。
  - abort 路径加 `session.instance.close?.()`：SIGKILL 进程组，不只 interrupt 当前 turn。
- **状态**：⚠️ **此提交的"complete 扣押"设计已被证伪**（见 #13/#14 与 bug 清单第 1 条）。重做时：注入通道可保留，但**不要让任何计数器扣押 complete**（修正版见 #14）；`settleRunningTasks` 与 upstream 的 tracker 二选一；`close()` 保留。

### 5. `98defc28` fix(chat): delta 按 sessionId 分桶 + 聚焦「拽回」修复 ✅

- **文件**：`useChatRealtimeHandlers.ts`、`ChatInterface.tsx`、`ChatMessagesPane.tsx`、两个测试。
- **内容**：`accumulatedStreamRef/accumulatedThinkingRef` 改为 `Map<sessionId, string>` 分桶——原单字符串让多会话/多子 agent 的流式增量交叉拼接；带 parentToolUseId 的 delta 不渲染；`ChatMessagesPane` 聚焦滚动加 `lastScrolledFocusTokenRef` 一次性消费（修"流式时被自动拽回卡片"）。
- **状态**：✅ 多会话/并发必需。upstream 也改过 `useChatRealtimeHandlers`（+61），重做时需要重新融合（本次合并已经做过一轮，可参考合并结果 `dd0b388c`）。

### 6. `285e3747` feat(claude): 模型目录运行时探测 ❌（已回退，保留其快照层）

- **内容**：运行时 spawn 一次 claude 问 `supportedModels()` 生成目录。
- **状态**：❌ **探测读得不准，已在 `dee12fae` 回退**。保留的是它的**替代方案**：本地快照 `models.json`（由 `bin/refresh-models.mjs` 手动生成）+ `claude-models.provider.ts` 的 `loadModelsFromFile()`（快照 → 内置目录两层）。重做时：**只做快照方案，绝不做运行时探测**。

### 7. `2fd6a469` feat(chat): 子 agent 叙述 markdown 化 + 任务提示透出 ✅

- **文件**：5 个，+59/−10。
- **状态**：✅ 小改动。注意 upstream 的 `SubagentPanel` 走 `MarkdownContent`，融合时取一即可。

### 8. `15c7240e` feat(chat): 面板时间线 transcript 化 + 可拖宽 ✅

- **文件**：`SubagentPanel.tsx`、`SubagentTimeline` 相关、`ChatMessagesPane.tsx`，+126/−66。
- **状态**：✅。与 upstream 的 `SubagentTimeline.tsx`（新文件）需要二选一或融合。

### 9. `dee12fae` fix(chat): 单写者锁 + 子 agent 判停 + 命令清单闭环 + 探测回退 ⚠️（混合提交，拆开看待）

- **文件**：16 个，+444/−281。
- **内容与状态**：
  - **单写者锁**（`isSessionProcessAlive` 谓词 + `dispatchRun` 拒绝 + 服务端代为排队 + 广播）：✅ 防双写的核心，保留。重做时注意与 upstream 的 `hasBackgroundWork` 会话保护共存（合并时已是共存形态）。
  - **子 agent liveness window**（mtime 静默判停）：❌ **已被 upstream 的 `launchedByLiveRun`（进程感知）取代**，合并时删除。不要重做。
  - **命令清单闭环**（/list 带 native、前端 menu 插入不执行、补 /context /model /hooks /rewind /statusline）：✅。
  - **模型探测回退**：✅（见 #6）。

### 10. `f1b2d515` feat(workspace): 目录搜索 + 文件树侧栏 + 可拖分栏 + shell fit 修正 ⚠️（含一个已回退的坑）

- **文件**：18 个，+599/−38。
- **内容与状态**：
  - **目录选择器搜索**：后端受限递归搜索（深度 4/结果 30/访问 4000，跳过隐藏与重目录）+ 弹窗搜索框。✅。
  - **FilesSidebar + 可拖分栏**：文件树变常驻侧栏。✅。
  - **shell 零尺寸 fit 保护**（两处 clientWidth===0 guard）：✅ 保留。
  - ❌ **同提交引入了"Shell 标签 CSS 隐藏不卸载"**（PTY 跨标签常驻 → shell 进程与会话 CLI 进程并存），已在 `fa4cff25` 回退为条件挂载。**重做时不要引入**。

### 11. `ba58ffd8` docs: 已知问题笔记 ✅（文档，按需）

### 12. `dd0b388c` merge upstream（新文件夹方案下不存在，仅作参照）

### 13. `f105e0a7` fix(chat): held-open 拒绝时注入优先 ⚠️

- **内容**：单写者锁拒绝时先尝试注入（否则排队）；`chat.queue.inject` 放宽到 held-open 态；claimed 消息派发失败时还原。
- **状态**：⚠️ 方向正确但**放大了 #14 修的缺陷暴露面**（注入成功但结果永不归来 → 客户端无反馈）。重做时：注入优先可保留，但必须搭配 #14 的"complete 不扣押"，并且认识到 push 本身不保证结果。

### 14. `349dcac5` fix(claude): 注入 turn 只扣进程、不扣 complete ✅（关键修正）

- **内容**：`injectedTurnCount/resultCount` 计数器**降级**——只决定进程是否保持（未回报的注入 turn 提前关 stdin 会丢消息），**complete 回归 `turnCompleteSent` latch（首个 result 即发）**。根因：`push()` 返回 true 只承诺消息进了内存队列，不承诺 CLI 会读它或回 result；原设计拿不可验证的跨进程承诺扣押终态，一次未回应的注入 = 会话永不 complete = 前端无卡片无反馈地转圈。
- **同时**：run 启动即武装 idle ceiling 的看门狗——**已在 `fa4cff25` 按用户决策移除**（卡死靠前端终止按钮，见 #15）。
- **状态**：✅ 计数器语义按本条重做。看门狗不要重做。

### 15. `fa4cff25` fix(workspace): shell 离标签卸载 + 终止覆盖残留进程 ✅

- **内容**：
  - 回退 shell 常驻（见 #10 的 ❌ 项）。
  - **`chat.abort` 不再因 registry 无 running run 而拒绝**：run 已结束但进程残留（held-open）时，best-effort 杀掉该会话的存留进程（不发终态帧，客户端早已 idle）。这是"卡死可从前端修复"的关键——终止按钮覆盖所有状态。
- **状态**：✅。

---

## 二、已知 bug 与遗留问题（重做时的决策点）

1. **注入机制的可靠性**（已缓解，未根除）：`push()` 成功 ≠ CLI 会处理。当前形态下未回应的注入不再扣押 complete（客户端无感），但消息本身可能滞留在 pending 队列直到天花板触发后**丢失**。若要根除：注入改为"只对确认 CLI 空闲时执行"，或接受消息可能丢失并在 UI 上标注。
2. **SDK 流静默卡死**：run 进行中 CLI 完全静默（不吐消息也不结束）→ 无 result → 靠用户手动点终止（`chat.abort` 现已覆盖所有状态）。专用心跳看门狗（短上界主动 interrupt）被用户决策推迟，如需要再补。
3. **queue 单槽覆盖**（设计级，未修）：`session_drafts.queued_message` 单列，第二条入队顶掉第一条且服务端无痕。修复方向：多行队列表 + 派发成功才删。
4. **前端终止按钮可见性**：`isProcessing` 才显示停止按钮；held-open 卡死时前端无按钮（静默杀进程路径需程序触发）。可考虑：检测到进程存活且后台任务挂死时显示终止入口。
5. **Windows 专项**：`os.tmpdir()` 加入 `FORBIDDEN_WORKSPACE_PATHS`（upstream 缺失，我们已补）；symlink 测试在 Windows 跳过（EPERM）。
6. **PowerShell 命令层坑**：长命令里的 `&&` 会被命令层吞掉（曾损坏过文件）——批量改代码用编辑工具，不要用 shell here-string。

---

## 三、新文件夹重做操作指南

```bash
# 1. 基于 upstream 最新 master 新建工作目录
git clone https://github.com/siteboon/claudecodeui.git ../claudecodeui-fresh
cd ../claudecodeui-fresh
git remote add origin <你的 fork 地址>   # 推送目标

# 2. 按依赖顺序逐项应用本文档第一节的条目，每项独立提交：
#    1 → 3(context-window) → 2(流式+面板, 先做面板设计决策) → 5(delta 分桶)
#    → 7 → 8 → 9(单写者锁+命令清单, 去掉 liveness) → 10(去掉 shell 常驻)
#    → 4+13+14(注入, 用修正版语义) → 11(文档)

# 3. 每项应用后：
npm install        # 注意 package.json 的 allowScripts 白名单（原生模块 postinstall）
npm run typecheck
npm test           # 基线：upstream 自带的失败集需先摸清
npx vitest run
```

**环境坑（全部实测）**：
- husky：commitlint 正文每行 ≤100 字符（PowerShell 多行信息用反引号 n 拼进单个 `-m`）；lint-staged v16 会把 `git stash create` 的 stdout 当 hash——**不要留"已修改未暂存"的 LF 文件**，否则 `fatal: Needed a single revision` 挡住所有提交。
- `oxlint` 是主 linter（0 warning 基线）；`npm test` 是 node:test（`tsx --test`，每文件独立进程）。
- zh-CN 的 i18n 没有 `folderBrowser` 段属正常（回退 en 是既有约定）。
- models.json 快照方案：改模型后手动跑 `refresh-models.sh`，不要放启动流程。
- 本仓库历史上有"重建历史"操作：对照提交时用 patch 内容比对，不要假设提交号两边一致。

---

## 四、一页速查：重做 vs 放弃

| # | 变更 | 重做？ |
|---|---|---|
| 1 | CLI 路径进程内解析 | ✅ |
| 2 | 流式 reasoning + 子 agent 面板 | ⚠️ 先做面板设计决策 |
| 3 | 上下文窗口学习 + forwardSubagentText + CLI 命令 | ✅ |
| 4 | 注入 + settle + close | ⚠️ 用 #14 修正语义；settle 与 tracker 二选一 |
| 5 | delta 分桶 + 聚焦防拽回 | ✅ |
| 6 | 模型运行时探测 | ❌ 只做快照方案 |
| 7 | 叙述 markdown 化 | ✅ |
| 8 | 面板时间线 transcript 化 + 拖宽 | ✅ |
| 9 | 单写者锁 + 命令清单 | ✅（liveness 部分不要） |
| 10 | 目录搜索 + 文件侧栏 + 拖宽 | ✅（shell 常驻不要） |
| 13 | 注入优先于排队 | ⚠️ 搭配 #14 |
| 14 | complete 不扣押 | ✅ |
| 15 | shell 离标签卸载 + abort 全覆盖 | ✅ |
