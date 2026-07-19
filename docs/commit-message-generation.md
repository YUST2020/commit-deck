# Commit Message 生成逻辑详解

> 本文档梳理「AI 提交信息」功能从用户点击「生成」到最终落盘提交的完整链路，覆盖每一处细节与交互。行号引用基于当前代码（`src/`）。

---

## 0. 总览

一次「生成 commit message」涉及 **四个进程层 + 一条流式通道**：

```
渲染进程 (AiCommitPanel.vue)         ← 用户交互入口
   │  useAiStore.generate()
   ▼
preload (contextBridge)              ← 只暴露具名方法，隔离 ipcRenderer
   │  ipcRenderer.invoke / .on
   ▼
主进程 IPC (ipc/ai.ts, ipc/git.ts)   ← 路由 + 校验 + AbortController 管理
   │
   ├──► DiffAggregator.ts            ← 取 diff + 聚合 + 大文件保护 + 按模型推算配额
   └──► AiService.ts                 ← 拼 URL + 发起 SSE 流式请求 + 解析增量
            │
            ▼  sender.send('ai:chunk' / 'ai:done' / 'ai:error')
        渲染进程订阅回调 → buffer 累积 → 节流 flush 到 message
```

**关键设计**：流式生成用「`invoke` 启动 + 主进程事件推增量 + `invoke` 中断」的组合，而非一次性 `invoke` 返回全文。这样能边生成边渲染，首字延迟低。

---

## 1. 配置与偏好（生成前的状态）

### 1.1 服务配置 `AiServiceConfig`

定义在 `src/shared/index.ts`，持久化于 electron-store 的 `aiService` 键。字段：

| 字段 | 含义 |
| --- | --- |
| `provider` | `'glm' \| 'deepseek' \| 'custom'`：预选服务商或自定义 |
| `presetModel` | 预选服务商的下拉模型 id（如 `glm-4.7-flash`） |
| `presetCustomModel` | 预选服务商是否自定义模型（true 则用 `model` 手填值） |
| `protocol` | 自定义协议 `'openai' \| 'anthropic'` |
| `urlMode` | 自定义 URL 模式 `'auto' \| 'full'` |
| `baseUrl` | 自定义基地址 |
| `model` | 自定义模型 id（预选自定义模式时也用此字段） |
| `apiKey` | 密钥（仅主进程存储） |
| `thinking` | 是否启用思考模式（DeepSeek / Anthropic 兼容端点） |
| `thinkingEffort` | 思考强度 `'high' \| 'max'` |

**默认配置**（`StoreService.ts: DEFAULT_AI_SERVICE`）：`provider: 'glm'`, `presetModel: 'glm-4.7-flash'`, `thinking: false`, `thinkingEffort: 'high'`。

**兼容性**：`normalizeAiService()` 对旧版本持久化数据补默认值，非法 `thinkingEffort` 回落 `'high'`。

### 1.2 偏好 `AiPrefs`

持久化于 `aiPrefs` 键，字段：

| 字段 | 含义 |
| --- | --- |
| `selectedPrefixByProject` | 各项目选中的前缀 id（按项目独立缓存） |
| `draftByProject` | 各项目的草稿 + 上次结果文本缓存 |
| `detailed` | 详细模式开关（true 则首行后追加 `- ` 子项列表） |
| `customRules` | 自定义生成规则（可重置） |
| `prefixes` | 前缀列表（跨项目共享） |

**兼容性**：`normalizePrefs()` 处理旧版单字段 `selectedPrefixId` 迁移，逐项校验 `draftByProject` 结构避免脏数据。

### 1.3 生成规则 `DEFAULT_AI_RULES`

`StoreService.ts` 与 `renderer/ai/prompts.ts` 各存一份**完全一致的副本**（SSOT 双写）：
- 主进程副本：初始化持久化默认值 + 「恢复默认」写盘
- 渲染进程副本：`resetRules()` 本地预览（避免往返闪烁）

规则核心：Conventional Commits 规范、type 白名单、中文 subject ≤50 字、不句号、不解释、直接输出。

---

## 2. 入口：渲染进程交互（`AiCommitPanel.vue`）

### 2.1 四态状态机 `AiPhase`

| phase | 主体区显示 | 工具栏按钮 |
| --- | --- | --- |
| `idle` | 草稿输入框（可选） | 生成 / 提交 / 提交并推送 |
| `generating` | 流式输出区（呼吸光点 + 闪烁光标） | 停止 |
| `editing` | 可编辑结果 | 重新生成 / 提交 / 提交并推送 |
| `error` | 错误提示 NAlert | 重试 / 配置 |

**主体文本区**（`bodyValue`）：`idle` 用 `ai.userDraft`，其余用 `ai.message`。`onBodyInput` 根据 phase 分别写入草稿（`setUserDraft`）或直接改 `message`（editing 态）。

### 2.2 前缀选择条

- 分段胶囊式（`div` 规避原生 button 样式），「无」+ 用户前缀列表。
- 选中态：品牌色背景 + `box-shadow: brand-glow`。
- 右侧两个圆角操作：`+` 快捷新增（自有 NModal，**禁用 `window.prompt`**）、`ListPlus` 管理。
- 选中按项目缓存到 `selectedPrefixByProject[activeId]`。

### 2.3 生成触发 `onGenerate`

1. `canGenerate` 校验（`git.files.length > 0`），无改动 `message.info` 提示。
2. 调 `ai.generate()`。

### 2.4 提交触发 `onCommit(push)`

1. idle 态有草稿 → 先同步到 `message`。
2. 空信息 → `message.warning`。
3. 调 `ai.commit({ push })`：
   - 成功 → `message.success`，清空状态回 idle。
   - 「已提交，但推送失败」→ 成功提示 + `dialog.error` 弹推送详情。
   - 失败 → `dialog.error`。

### 2.5 被忽略文件弹层（NPopover）

工具栏显示「N 个文件已折叠」按钮（`FileWarning` 图标），点击弹层列出：
- 文件路径（ellipsis）+ reason 标签（`omittedLabel` / `omittedTagType`）。
- **强制包含开关**：非二进制文件可点（`Zap` / `ZapOff` 图标），二进制禁用 + tooltip 说明。
- 底部「重新生成（含 N 个强制文件）」按钮（仅当有强制项时显示）。

---

## 3. 核心编排：`useAiStore.generate()`

### 3.1 前置校验

```ts
if (!repoPath) return
if (!ensureConfigured()) return  // 缺 apiKey → 打开配置弹窗 + error 态
```

### 3.2 重置态

```ts
phase = 'generating'
error = null; buffer = ''; message = ''
truncated = false; omittedFiles = []
```

### 3.3 取 diff（关键步骤）

**计算 model 传给主进程**（用于按上下文长度动态推算配额）：

```ts
const modelForDiff = cfgSnap
  ? cfgSnap.presetCustomModel ? cfgSnap.model : cfgSnap.presetModel
  : undefined
const diffRes = await window.api.gitDiffForAi(repoPath, modelForDiff, forceIncludePaths.value)
```

失败 → error 态；空 diff → `'没有可生成的改动'`。

返回的 `{ diff, truncated, source, omittedFiles }` 写入响应式 state。

### 3.4 组装消息 `buildMessages`

```ts
const messages = buildMessages(
  { rules, prefix, detailed, source, userDraft, truncated },
  diff
)
```

详见 [§4 Prompt 构造](#4-prompt-构造-prompts)。

### 3.5 调试打印（开发态）

DevTools 与主进程终端各打印一次完整 prompt（`console.groupCollapsed [AI Prompt]`），含消息数、来源、diff 字符数、是否含草稿、思考标记。

### 3.6 订阅流 + 启动生成

```ts
subscribe()  // 幂等：先解绑旧订阅
const plainConfig = JSON.parse(JSON.stringify(toRaw(config.value!)))
const plainMessages = JSON.parse(JSON.stringify(messages.map(toRaw)))
const res = await window.api.aiGenerate({ repoPath, config: plainConfig, messages: plainMessages })
```

**⚠️ 关键**：IPC 无法 structured-clone Vue 响应式 Proxy，**必须** `toRaw` + JSON 往返去 Proxy（见 AGENTS.md 共性 Bug）。`setAiService` / `setAiPrefs` 同理用 `toPlain()`。

失败兜底：若 error 事件未先到，则 `phase='error'`。

### 3.7 中断 `abort()`

```ts
await window.api.aiAbort()
// flush 残留 buffer，保留已生成文本
phase = message.trim() ? 'editing' : 'idle'
```

用户主动中断视为 done（保留部分结果可编辑），**不**视为 error。

---

## 4. Prompt 构造（`prompts.ts`）

### 4.1 `buildSystem(opts)` 拼接 system 消息

按顺序拼接：

1. **rules**（用户自定义或 `DEFAULT_RULES`）。
2. **输出结构**：
   - `detailed=true`：首行 subject + 空行 + 2~5 条 `- ` 子项（具体做了什么）。
   - `detailed=false`：仅一行 subject，无正文。
3. **前缀注入**（有 prefix 时）：强制要求首行以 `<prefix>` 开头（示例 `${prefix}: 描述` 或 `${prefix} 描述`）。
4. **改动来源说明**：
   - `source='all'`：提示「包含工作区所有未提交改动（未暂存 + 未跟踪），请总结整体改动」。
   - `source='staged'`：提示「已暂存的改动」。
5. **截断告知**（`truncated=true`）：提示「差异因体积被截断，仅基于已展示内容总结，不要臆测；subject 末尾可用（等）收尾」。

### 4.2 `buildUser(diff, userDraft)` 拼接 user 消息

```
请根据下面的 git diff 生成 commit message：
                          ← 有草稿时插入：
我已写下一些要点，请在润色后融合进最终 commit message（可调整措辞、补全规范，但不要丢弃我的意图）：
---
<userDraft>
---
                          ← diff 块
```diff
<diff>
```
```

**草稿润色**：用户 idle 态手写的要点会作为补充上下文，让 AI 润色而非丢弃。

### 4.3 `buildMessages`

固定 `[system, user]` 两条消息（无 assistant 历史，单轮生成）。

---

## 5. 主进程 IPC 路由

### 5.1 `git:diffForAi`（`ipc/git.ts`）

```ts
ipcMain.handle('git:diffForAi', async (_e, repoPath, model?, forceIncludePaths?) => {
  assertValidPath(repoPath)  // 必须绝对路径，防越权
  const m = typeof model === 'string' ? model : undefined
  const force = Array.isArray(forceIncludePaths)
    ? forceIncludePaths.filter((p): p is string => typeof p === 'string')
    : []
  return guard(() => aggregateDiffForAi(repoPath, m, force))
})
```

`guard()` 统一包装为 `{ ok, data } | { ok, error: { message } }`。

### 5.2 `ai:generate`（`ipc/ai.ts`）—— 流式生成的核心

**任务分发**（`AiTask = 'commit' | 'review'`）：
- `task='commit'`（默认）→ 事件 `ai:chunk` / `ai:done` / `ai:error`
- `task='review'` → `ai:review:chunk` / `ai:review:done` / `ai:review:error`

两套事件通道彻底解耦，commit 流与 review 流互不污染 buffer。

**AbortController 管理**：`controllers = Map<WebContents, AbortController>`，每个窗口（webContents）独立，同窗口任意时刻**只允许一个进行中的流**。新任务启动会 abort 旧任务（防御性）。

**流程**：

```ts
1. assertValidPath(repoPath)
2. 校验 config / messages 类型
3. 解析 task → eventsFor(task)
4. validateConfig(config) 预检 → 失败返回 { ok:false, error }
5. abort 该窗口旧流，新建 AbortController，注册 destroyed 清理
6. streamGenerate(config, messages, { signal, onChunk: sender.send(ev.chunk, delta) })
7. 成功 → sender.send(ev.done)；返回 { ok:true }
   catch:
     - signal.aborted（用户中断）→ 视为 done，返回 { ok:true }
     - 其它错误 → sender.send(ev.error, { message })；返回 { ok:false, error }
   finally: clearController + removeListener('destroyed')
```

**防御**：每次 `sender.send` 前判 `!sender.isDestroyed()`，避免窗口已销毁还推送。

### 5.3 `ai:abort`

```ts
const controller = controllers.get(e.sender)
if (controller) controller.abort()
```

中断当前流（触发上述 `signal.aborted` 分支）。

### 5.4 `ai:test`（连通性测试）

```ts
validateConfig → testConnection(config) → { ok } | { ok:false, error }
```

**不进 `controllers` map**（一次性 invoke，无流事件），与 `ai:generate` 区分。连通性测试**不带 thinking 参数**（思考模式更慢更贵，对验证无意义）。

### 5.5 AI 配置 / 偏好持久化

- `ai:getService` / `ai:setService` → `StoreService.getAiService` / `setAiService`（写时 `normalizeAiService` 规范化）。
- `ai:getPrefs` / `ai:setPrefs` → 同理。
- `ai:resetRules` → `StoreService.resetAiRules()`（写回 `DEFAULT_AI_RULES` 并返回）。

---

## 6. Diff 聚合（`DiffAggregator.ts`）—— 核心难点

### 6.1 入口 `aggregateDiffForAi(repoPath, model?, forceIncludePaths?)`

**第一步：暂存优先**

```ts
const stagedRaw = await git.diff(['--cached'])
if (stagedRaw.trim()) {
  return { diff, truncated, omittedFiles, source: 'staged' }  // 仅暂存
}
```

**第二步：无暂存 → 全量工作区**

```ts
const trackedRaw = await git.diff(['--'])  // 已跟踪改动（不含 untracked）
const st = await git.status()
const untracked = st.not_added ?? []       // 未跟踪文件
```

分别处理后合并，`source: 'all'`。

### 6.2 按模型推算配额 `computeMaxDiffChars(model)`

`MODEL_CONTEXT_MAP`（按数组顺序匹配，首个命中生效）：

| 模式 | 上下文 token |
| --- | --- |
| `glm-4.7` | 200,000 |
| `gpt-4o \| claude-3.*sonnet \| glm-4 \| qwen-?2.5 \| deepseek.*(v3\|v4)` | 128,000 |
| `gpt-4 \| claude-3.*haiku \| qwen-?7` | 32,000 |
| `.*`（兜底） | 8,000 |

```ts
usable = max(ctx - 2000, 4000)   // 预留 2K 给 system + 输出
return floor(usable * 3.5)       // 1 token ≈ 3.5 字符（代码 diff 以 ASCII 为主）
```

未知模型（model 为空或未命中）回落 `MAX_TOTAL_CHARS = 30000`。

**维护提示**：新增模型时按官方标称上下文长度补一条 pattern。

### 6.3 大文件保护 `shouldOmitContent(filePath)`

按顺序判定（命中即返回折叠原因）：

| 判定 | reason | note |
| --- | --- | --- |
| 扩展名在 `BINARY_EXTENSIONS`（图片/音视频/压缩包/可执行/字体/文档二进制等） | `binary` | 二进制文件，内容已省略 |
| 文件名在 `LOCK_OR_GEN_FILES`（`package-lock.json` / `pnpm-lock.yaml` / `cargo.lock` 等） | `generated` | 锁文件 / 产物 |
| 路径含 `GENERATED_PATH_SEGMENTS`（`node_modules/` / `dist/` / `build/` 等） | `generated` | 产物目录 |
| 后缀在 `GENERATED_SUFFIXES`（`.min.js` / `.map` 等） | `generated` | 压缩/混淆产物 |

**额外**：git 输出 `Binary files a/x and b/x differ`（扩展名不在黑名单如 `.dat`）也统一折叠为 `binary`（强制无效）。

### 6.4 单文件处理 `processFileDiff(block, filePath, force=false)`

```
1. shouldOmitContent 命中 → 仅保留 header + 折叠说明（force 无效）
2. git 输出 "Binary files ... differ" → 折叠为 binary（force 无效）
3. !force && block.length > MAX_FILE_CHARS(15000)
   → 统计 +N -M 行，折叠为 too_large（force=true 跳过此折叠，保留全文）
4. 否则原样返回
```

`keepHeader()` 提取 diff 头（到首个 `@@` 前）。

### 6.5 三层优先级装填 `filterAggregatedDiff`

**切分**：`splitByFile()` 按 `diff --git ` 分块；`extractFilePath()` 取 `+++ b/xxx`（删除取 `--- a/xxx`）。

**装填策略**（保证重要文件优先进入上下文）：

1. **第一优先：强制包含且未折叠的文件**（`forceIncludePaths` 命中）
   - 优先占用配额；装得下 → 直接纳入。
   - 装不下 → `truncateHunks` 按 hunk 部分截断（保留 header + 尽可能多完整 hunk + 截断标记），**而非整块丢弃**。
   - 预算连 header + 标记都装不下 → 放弃该强制文件，落到 omitted。
2. **第二优先：折叠文件**（占空间小，仅 header + 说明行）
   - 直接纳入，价值在于「告知存在」。
3. **第三优先：未折叠非强制文件** 按 `filePriority` 降序竞争剩余配额。
   - 同优先级按原顺序（稳定排序）。
   - 装不下的文件**整块丢弃**，仅保留 header + 截断标记，记入 omitted（reason=`size_limit`）。

**`filePriority(filePath, changeLines)`**：

| 类别 | 优先级 |
| --- | --- |
| 测试文件（`*.test.*` / `*.spec.*` / `*.snap`） | 0（最低） |
| 样式（`css/scss/...`） | 1 |
| 文档/配置（`md/json/yml/...`） | 2 |
| 源码（默认）：改动行数 20~200 加权 | 10 + (2 或 1) |

**输出顺序**：按文件原顺序（保持 diff 阅读连贯），**不**按优先级重排。

**`truncated` 标记**：有文件未纳入 **或** 强制文件被部分截断 → `true`。

### 6.6 未跟踪文件 `diffForUntracked`

为未跟踪文件构造类 diff 文本（全为新增行）：

```ts
header = `diff --git a/${f} b/${f}\nnew file mode 100644\n--- /dev/null\n+++ b/${f}\n`
1. shouldOmitContent 命中 → header + 折叠说明
2. fs.statSync 失败 → header + '[file not readable]'
3. !force && size > MAX_UNTRACKED_FILE_BYTES(64KB) → 折叠为 too_large
4. readFileSync 失败 → '[file not readable]'
5. 含 NUL 字节（二进制特征）→ 折叠为 binary（force 无效）
6. 每行加 '+' 前缀，拼成 `@@ -0,0 +1,N @@` hunk
7. 走 processFileDiff 统一处理超长折叠（force 透传）
```

未跟踪文件也走**相同的三层优先级装填**（强制优先 → 折叠 → 按优先级竞争）。

### 6.7 最终聚合

```ts
const diff = parts.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()
return { diff, truncated, omittedFiles: omitted, source }
```

压缩多余空行，trimEnd。

---

## 7. AI 服务请求（`AiService.ts`）

### 7.1 端点解析 `resolveEndpoint(config)`

| provider | url | model |
| --- | --- | --- |
| `glm` | `https://open.bigmodel.cn/api/paas/v4/chat/completions` | `presetCustomModel ? model.trim() : presetModel` |
| `deepseek` (openai) | `https://api.deepseek.com/chat/completions` | 同上 |
| `deepseek` (anthropic) | `https://api.deepseek.com/anthropic/messages` | 同上 |
| `custom` + `urlMode='full'` | `baseUrl` 原样 | `model.trim()` |
| `custom` + `urlMode='auto'` | `trimSlash(baseUrl) + ('/chat/completions' \| '/messages')` | `model.trim()` |

`trimSlash()` 去尾部斜杠避免双斜杠。

### 7.2 配置校验 `validateConfig`

```ts
!apiKey.trim() → '未配置 API Key'
!model → '未配置模型 ID'
!url || !/^https?:\/\//.test(url) → '请求地址不合法'
```

### 7.3 流式生成 `streamGenerate`

**开发态打印 prompt**（主进程终端，与渲染进程 DevTools 打印一致）。

按 `protocol` 分发：

#### OpenAI 协议 `streamOpenAI`

```ts
fetch(url, {
  method: 'POST',
  signal,
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
  body: {
    model, messages, stream: true,
    ...(!isGlm && thinking
      ? { thinking: { type: 'enabled' }, reasoning_effort: thinkingEffort }
      : {})
  }
})
```

**⚠️ GLM 不接收 `thinking` / `reasoning_effort` 参数**（思考机制不同，传未知参数会被服务端拒绝），故仅非 glm 时附加。

**SSE 解析**：`[DONE]` 结束；取 `choices[0].delta.content` 增量；`reasoning_content`（思维链）**静默丢弃**。

#### Anthropic 协议 `streamAnthropic`

```ts
// system 单独传，messages 只含 user/assistant
fetch(url, {
  headers: {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01'
  },
  body: {
    model,
    ...(systemMsg ? { system: systemMsg.content } : {}),
    messages: turns,
    max_tokens: 1024,
    stream: true,
    ...(thinking ? { output_config: { effort: thinkingEffort } } : {})
  }
})
```

**SSE 解析**：仅采纳 `type==='content_block_delta'` 事件的 `delta.text` 增量；思维链增量被过滤。

### 7.4 SSE 通用解析 `parseSse`

逐行读取流，按空行分隔事件块，提取所有 `data:` 行回调。兼容：
- OpenAI（一行一个 data）
- Anthropic（event + data 行）
- SSE 注释 / 心跳（`:` 开头）忽略
- `event:` / `id:` / `retry:` 行不处理

中断时 `reader.cancel()` 释放。`finally: reader.releaseLock()`。

### 7.5 错误处理 `httpErrMsg`

HTTP status → 中文文案映射（400/401/403/404/429/500/502/503/504），未知 status 兜底，附响应体（`safeReadText` 限制 ≤500 字符，超出截断加 `…`）。

### 7.6 连通性测试 `testConnection`

```ts
fetch(url, {
  method: 'POST',
  signal: AbortSignal.timeout(15000),  // TEST_TIMEOUT_MS，防代理 hang
  headers,  // 按协议区分 Bearer / x-api-key
  body: { model, messages: [{ role:'user', content:'ping' }], max_tokens: 1, stream: false }
})
```

最小请求验证鉴权 / 地址 / 模型可达性，**不带 thinking**。失败抛 `httpErrMsg`。

---

## 8. 渲染进程流式渲染（性能优化）

### 8.1 buffer + 节流 flush

```ts
const buffer = shallowRef('')  // 流式累积，shallowRef 避免逐字符深响应式
const message = ref('')         // 展示用，由 flush 定时同步

function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    message.value = buffer.value
  }, 30)  // 每 ~30ms 批量刷新一次
}
```

**为什么**：流式增量高频到达，逐字符 `+=` 到响应式 `ref` 会触发整组件重渲染。用 `shallowRef` + 节流（30ms）批量写展示值，渲染性能可控。

### 8.2 事件订阅 `subscribe`（幂等）

```ts
onAiChunk(delta) → buffer += delta; scheduleFlush()
onAiDone() → flush 残留; message = buffer; userDraft=''; phase='editing'
onAiError(err) → flush 残留; message = buffer; error = err.message; phase='error'
```

**幂等**：重复调用先 `unsubscribe()` 解绑旧的，避免重复订阅。

### 8.3 生成中 UI

专用 `.ai__stream` 区（不置灰）：
- 顶栏：呼吸光点（`@keyframes pulse`，1.2s 循环）+ 「生成中」标签。
- 输出区：`white-space: pre-wrap`，行内闪烁光标（`@keyframes blink-caret`，1s steps(2)）。
- 无内容时显示斜体「等待响应…」。

---

## 9. 强制包含（被截断文件的反向操作）

### 9.1 状态

```ts
const forceIncludePaths = ref<string[]>([])  // 内存临时态，不落盘
// 每次 generate 不清空（支持同批 diff 反复调整重生成），切换项目时清空
```

### 9.2 交互（`AiCommitPanel.vue` 被忽略弹层）

- 非二进制文件：可点的 `Zap`/`ZapOff` 按钮，tooltip 说明「下次生成将尽量发送全文（总量超限时部分截断）」。
- 二进制文件：禁用 + tooltip「二进制内容无法解析，不可强制包含」。
- 有强制项时显示「重新生成（含 N 个强制文件）」按钮。

### 9.3 透传到主进程

```ts
window.api.gitDiffForAi(repoPath, modelForDiff, forceIncludePaths.value)
```

IPC handler 校验 `forceIncludePaths` 必须是字符串数组（过滤非 string）。主进程 `aggregateDiffForAi` 透传到 `filterAggregatedDiff` / `diffForUntracked`，强制文件**优先占用配额 + 尽量发全文**（force=true 跳过单文件过大折叠，超总配额时部分截断）。

---

## 10. 按项目草稿持久化

### 10.1 debounce 落盘

```ts
const DRAFT_DEBOUNCE_MS = 500
function scheduleSaveDraft(): void {
  draftTimer = setTimeout(() => persistDraftNow(pid), 500)
}
```

文本输入高频，逐字符写 electron-store 会反复 IPC + 磁盘 IO，用 500ms 防抖合并。

### 10.2 `persistDraftNow(pid)`

```ts
const next = { draft: userDraft, message: phase==='editing' ? message : '' }
// 值未变化则跳过写盘（避免无意义 IO）
if (prev.draft===next.draft && prev.message===next.message) return
drafts[pid] = next
persistPrefs({ ...prefs, draftByProject: drafts })
```

**只在 idle / editing 态持久化**（generating 流式中间态不落盘，切走时丢弃）。

### 10.3 提交后清空

```ts
async function commit(...) {
  // 提交成功后
  userDraft = ''; message = ''
  await clearDraft(committedPid)  // 清掉持久化层
}
```

### 10.4 切换项目 `switchProject(prevId, nextId)`

```
1. 取消未决的 debounce 落盘（避免把旧项目文本写到新项目 key）
2. 离开旧项目：
   - generating 态 → abort + 丢弃部分结果
   - idle/editing/error 态 → persistDraftNow(prevId) 落盘
3. 重置临时态（unsubscribe / clear timers / phase='idle' / 清空 buffer/omitted/force）
4. 恢复新项目文本（draftByProject[nextId]）
   - message 恢复后 phase 仍复位为 idle（让用户重新审视，避免一进来就停在提交按钮态）
```

---

## 11. 提交与推送 `commit({ push })`

```ts
async function commit({ push }) {
  if (!repoPath) return { ok:false, message:'未选择项目' }
  const msg = message.value.trim()
  if (!msg) return { ok:false, message:'提交信息为空' }

  const commitRes = await window.api.gitCommit(repoPath, msg)
  if (!commitRes.ok) return { ok:false, message: commitRes.error.message }

  // 提交成功：立即清空内存状态，UI 快速反馈
  userDraft = ''; message = ''
  await git.refreshAll()         // 刷新 status + log + branch
  await clearDraft(committedPid) // 清掉持久化层

  if (!push) return { ok:true, message:'已提交', commitHash }

  const pushRes = await window.api.gitPush(repoPath)
  if (!pushRes.ok) {
    // commit 成功但 push 失败：特殊标记，调用方分别提示
    return { ok:true, message:'已提交，但推送失败：' + pushRes.error.message, commitHash }
  }
  await git.refreshAll()
  return { ok:true, message:'已提交并推送', commitHash }
}
```

**返回值约定**：成功 `{ ok:true, message, commitHash? }`，失败 `{ ok:false, message }`。调用方（`AiCommitPanel.onCommit`）按 `message.startsWith('已提交，但推送失败')` 分支弹窗。

---

## 12. 数据流时序图（一次完整生成）

```
用户点「生成」
   │
   ▼ AiCommitPanel.onGenerate → ai.generate()
[渲染] ensureConfigured → 取 modelForDiff
   │
   ▼ window.api.gitDiffForAi(repoPath, model, forceIncludePaths)
[IPC]  git:diffForAi → aggregateDiffForAi
   │    ├─ git.diff --cached（有则 staged）
   │    └─ git.diff -- + status.not_added（无暂存则 all）
   │    ├─ processFileDiff（折叠二进制/产物/超长）
   │    └─ filterAggregatedDiff（三层装填 + truncateHunks）
   ▼ 返回 { diff, truncated, source, omittedFiles }
[渲染] 写入 state（omittedFiles 驱动弹层）
   │
   ▼ buildMessages → subscribe → aiGenerate({ repoPath, config, messages })
[IPC]  ai:generate → validateConfig → AbortController
   │
   ▼ streamGenerate → streamOpenAI/streamAnthropic → fetch(SSE)
[AI]   增量返回 delta
   │
   ▼ sender.send('ai:chunk', delta)  ← 多次
[渲染] onAiChunk → buffer += delta → scheduleFlush(30ms) → message 更新 → UI 流式渲染
   │
   ▼ sender.send('ai:done')
[渲染] onAiDone → flush 残留 → message = buffer → userDraft='' → phase='editing'
   │
   ▼ aiGenerate invoke resolve { ok:true }
[渲染] 用户编辑结果 → 点「提交」/「提交并推送」
   │
   ▼ ai.commit({ push })
[IPC]  git:commit → [git:push] → git.refreshAll
   │
   ▼ clearDraft → 清空状态 → phase='idle'
```

---

## 13. 边界与已知约束（避坑）

1. **IPC 传参不可为 Vue 响应式对象**：`config` / `messages` / `prefs` 跨 IPC 前必须 `toRaw` + JSON 往返去 Proxy（`useAiStore` 的 `toPlain` / 内联 JSON.parse(JSON.stringify)）。违反会报 `An object could not be cloned`。
2. **渲染进程禁用 `window.prompt/alert/confirm`**：沙箱环境，用 Naive UI 的 `NModal` / `useDialog` 替代（如快捷新增前缀弹窗）。
3. **GLM 不接收 thinking 参数**：`streamOpenAI` 仅 `!isGlm(config) && thinking` 时附加 `thinking` / `reasoning_effort`，否则服务端拒绝。
4. **AbortController 单流约束**：同窗口任意时刻只能跑一个流，新任务 abort 旧任务。
5. **强制包含对二进制/产物无效**：`shouldOmitContent` 命中的文件强制也仍折叠；只有「单文件过大（too_large）」和「未跟踪文件过大」的强制才生效（force 跳过折叠）。
6. **截断告知进 system prompt**：`truncated=true` 时注入「仅基于已展示内容总结，不要臆测」，避免模型编造未展示文件的改动。
7. **草稿润色不丢弃意图**：userDraft 作为补充上下文，要求 AI「润色后融合，可调整措辞但不要丢弃我的意图」。
8. **思考模式静默消费 reasoning**：流式只取最终 `content`，思维链 `reasoning_content` / thinking delta 被丢弃，用户无感。
9. **连通性测试不带 thinking**：思考模式更慢更贵，对验证鉴权/可达性无意义。
10. **model 为空回落常量**：`computeMaxDiffChars(undefined)` → `MAX_TOTAL_CHARS=30000`。
11. **AGENTS.md 是 SSOT**：DEFAULT_RULES 在主进程（`StoreService`）与渲染进程（`prompts.ts`）各一份，修改时需**同步两边**。

---

## 14. 相关文件索引

| 文件 | 职责 |
| --- | --- |
| `src/renderer/components/AiCommitPanel.vue` | 交互入口、四态 UI、前缀条、被忽略弹层 |
| `src/renderer/stores/useAiStore.ts` | 状态机编排、流式累积、提交、按项目草稿 |
| `src/renderer/ai/prompts.ts` | system/user 消息构造（renderer 副本） |
| `src/renderer/ai/prefixId.ts` | 渲染进程前缀 id 生成（无 Node crypto） |
| `src/preload/index.ts` | contextBridge 暴露 `window.api` |
| `src/main/ipc/ai.ts` | `ai:generate` / `ai:abort` / `ai:test` + AbortController |
| `src/main/ipc/git.ts` | `git:diffForAi` / `git:commit` / `git:push` 等 |
| `src/main/services/AiService.ts` | 端点解析、流式请求、SSE 解析、连通性测试 |
| `src/main/services/DiffAggregator.ts` | diff 聚合、大文件保护、三层装填 |
| `src/main/services/StoreService.ts` | electron-store 持久化、DEFAULT_AI_RULES（main 副本） |
| `src/shared/index.ts` | 跨进程类型（`AiServiceConfig` / `AiPrefs` / `DiffForAi` / `OmittedFile` 等） |
| `src/shared/global.d.ts` | `window.api` 类型声明 |
| `src/renderer/components/AiServiceConfigModal.vue` | 服务配置弹窗（provider/模型/思考模式/连通性测试） |
| `src/renderer/components/PrefixManager.vue` | 前缀管理弹窗（增删 + 拖拽排序） |
