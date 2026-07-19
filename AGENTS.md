# AGENTS.md — 协作规范

> 所有协作者在本仓库工作时的强制规范。**写代码前先读完。**

## 项目

- **应用**：CommitDeck —— AI 驱动的 Git 提交信息桌面助手
- **技术栈**：Electron + Vue 3 + Vite + TypeScript + Naive UI + Pinia + Tailwind CSS v4
- **设计风格**：简约、现代、统一。冷调中性色 + 靛蓝主色，低饱和、小圆角、轻阴影。

## 1. Token 体系（核心）

**所有视觉决策走 token，禁止硬编码颜色/尺寸/字号/圆角/阴影。**

三层 token：

| 层 | 文件 | 说明 |
| --- | --- | --- |
| Primitive | `src/renderer/tokens/tokens.ts` | 原子值（色阶/字号/间距/圆角/阴影） |
| Semantic | 同文件 `light/darkSemantic` | 语义命名（`bgApp`/`textPrimary`/`brand`…） |
| CSS 变量 | `src/renderer/tokens/tokens.css` | `--bg-app` 等，供 CSS/Tailwind 引用 |

主题映射由 `composables/useTheme.ts` 注入 Naive UI。

- CSS 用 `var(--xxx)`，Tailwind 用语义 utility（`bg-panel`/`text-primary`/`text-brand` 等），JS 用 `import { ... } from '@/tokens/tokens'`。
- 新增 token（复用 ≥2 次）：改 `tokens.ts` + 同步 `tokens.css`（必要时补 `styles/tailwind.css` 的 `@theme inline`）。SSOT。
- 命名：semantic 用用途（`--text-secondary`），primitive 用刻度（`--sp-8`/`--fs-md`/`--r-lg`）。
- 不自己判 `isDark` 切色；CSS 变量随 `data-theme` 自动切换，读暗色态用 `useTheme().isDark`。

## 2. 交互与动画

**风格：现代化、有反馈、克制不花哨。** 每个可交互元素都让用户感知到响应。

- **过渡**：可交互元素的状态变化都加 `transition`，用 `var(--dur-base)` + `var(--ease-standard)`（120~260ms）。
- **入场**：列表项/弹层/面板首次出现加淡入 + 微位移；长列表用 `--stagger` 错峰。时长 ≤ `--dur-slow`(260ms)。
- **hover**：轻微背景变深 / `scale(1.02~1.06)` / 图标变色。
- **选中态**：品牌色指示条（左竖条/圆点，带高度动画）+ 选中底色。
- **焦点**：全局 `:focus{outline:none}`，仅 `:focus-visible` 显示品牌色 outline；点击不留胶囊 ring。
- **性能**：只用 `transform`/`opacity` 做动画，避免重排。
- **反馈**：异步用 `n-spin`/骨架，成功失败用 `useMessage()`，长列表用 `n-scrollbar`。

### 布局
- 分区用 `n-split`（可拖拽），子内容撑满格子，`min/max` 用 0~1 比例。
- split 格子内面板：根 `height:100%; display:flex; flex-direction:column`，滚动区 `flex:1; min-height:0; overflow:auto`。**禁止写死高度**。
- 页面栅格用 CSS `grid`，列宽 `minmax(0, Nfr)`。切分线用 `border` + `var(--border)`。

### 空态
- **不用 `n-empty`**。用自定义占位卡片：图标容器 + 标题（`var(--fs-md)` 600）+ 副说明（`var(--fs-sm)` tertiary），居中带淡入。
- 区分"未选择"（引导操作）和"无数据"（状态说明），用不同图标/文案，并告诉用户下一步做什么。

### 列表
- 单行信息同行排列：主信息 `flex-shrink:0`，次要信息 `flex:1; min-width:0; ellipsis`，hover 用 `title`。
- stagger 入场 + 选中态品牌色指示条（`::before` 高度动画）。

### 多形态适配
- 同一组件的多形态（折叠/展开、空态/有数据、宽窄屏）单独验证，必要时写 `.--collapsed`/`.--empty` 分支。
- 折叠态隐藏次要文字、改图标、tooltip 补充。

## 3. 技术栈边界

| 场景 | 用 | 不用 |
| --- | --- | --- |
| UI 组件 | **Naive UI** | 其它库/自研 |
| 工具类 | **Tailwind v4**（布局/间距） | 手写重复 utility |
| 状态 | **Pinia** | Vuex / 全局单例 |
| Git | **simple-git**（主进程） | nodegit / isomorphic-git |
| 网络 | Node 内置 `fetch` | axios |
| 持久化 | **electron-store** | 手写 JSON |
| 图标 | **`lucide-vue-next`** | `@vicons/*` / 多套图标库 |
| 路由 | `useUiStore.activeView` | vue-router |

**进程职责**：主进程管 fs/Git/网络；preload 用 `contextBridge` 只暴露具名方法；渲染进程沙箱（`nodeIntegration:false`）。IPC 一律 `invoke`/`handle` 并校验入参。

**图标用法**：lucide 是独立 Vue 组件，直接 `<Plus :size="18" />`，**不要**包在 `<n-icon>` 里；Naive 的 `#icon` slot 直接放 lucide 组件。

## 4. 代码风格

- TS `strict: true`；禁 `any`，用 `unknown` + 守卫。
- Vue `<script setup lang="ts">`，内容序：script → template → `<style scoped>`。
- 命名：组件 PascalCase、函数 camelCase、常量 UPPER_SNAKE、CSS kebab-case、store `useXxxStore`。
- 公共类型放 `src/shared/`（跨进程）或 `src/renderer/types/`。
- 组件 >250 行拆分；复用逻辑抽 `composables/useXxx.ts`。

**目录**：`src/main`(主进程 ipc/+services/) · `src/preload` · `src/shared`(跨进程类型) · `src/renderer`(tokens/styles/composables/stores/components/views/types)。

**提交**：分支 `main`/`dev`/`feat-xxx`/`fix-xxx`，Conventional Commits（中文 subject），提交前 `npm run typecheck`。

## 5. 样式决策优先级

1. **优先 Tailwind utility**（能 utility 就不写 scoped CSS）。
2. **颜色一律走语义 token**：`bg-panel`/`text-primary`/`text-brand`/`text-success` 等；**禁止** `bg-white`/`bg-gray-100`/`text-indigo-600`/`bg-[#xxx]` 等默认色板和任意值。
3. **间距/圆角/字号用 Tailwind 原生刻度**（`p-4`/`rounded-md`/`text-sm`，项目刻度已对齐 Tailwind）。
4. **不用 `dark:` 变体**（语义 utility 随 `[data-theme]` 自动切换）。
5. **scoped CSS 留给**：复杂动效/`@keyframes`、伪元素装饰、Naive 内部覆盖（`:deep()`）、媒体查询。
6. **不引入新 UI 库**，先用 Naive UI 拼装。
7. 不确定留 `// TODO(agent): 需确认 xxx`，不要猜。

## 6. 已知共性 Bug 记录

> 修复中发现的、具有共性/易复现的问题，记录在此，避免重复踩坑。

### IPC 传参不能是 Vue 响应式对象（`An object could not be cloned`）

**现象**：渲染进程调用 `window.api.*`（最终走 `ipcRenderer.invoke`）传 ref/Pinia state 时报 `Uncaught Error: An object could not be cloned`。

**根因**：Electron IPC 用 structured clone 序列化参数，而 Vue 的响应式 Proxy（`ref().value`、展开自 ref 的对象、Pinia setup store 的 state）**无法被 clone**。

**规则**：**凡是跨 IPC 边界传参，一律先转纯对象**。在 `useAiStore.ts` 用了 `toPlain()`（`JSON.parse(JSON.stringify(v))`）统一处理；也可用 `toRaw()`。涉及点：`setAiService` / `setAiPrefs` / `aiGenerate` 的 config 与 messages。新建 IPC 调用时务必遵循。

### Electron 沙箱禁用 `window.prompt/alert/confirm`

**现象**：渲染进程调用 `window.prompt()` 报 `prompt() is and will not be supported.`。

**规则**：渲染进程处于沙箱（`nodeIntegration:false` + `sandbox`），**禁止用原生 `prompt/alert/confirm`**。需要输入确认时一律用 Naive UI 的 `NModal`/`useDialog().warning` 等组件实现。

### lucide 图标必须显式 import（`Failed to resolve component: XXX`）

**现象**：控制台报 `[Vue warn]: Failed to resolve component: FolderOpen`（或其它 lucide 图标名）。

**根因**：lucide-vue-next 是独立 Vue 组件，**不会全局自动注册**。模板里用了未 import 的图标，Vue 会把它当成未知自定义元素。

**规则**：每个用到的 lucide 图标都要在 `<script setup>` 显式 `import { XxxIcon } from 'lucide-vue-next'`。新增图标后若页面空白/报 resolve 警告，先查 import 列表。

### Naive Button 互斥属性（`dashed/ghost/text` 与 `secondary/tertiary/quaternary`）

**现象**：控制台报 `[naive/button]: 'dashed', 'ghost' and 'text' props can't be used along with 'secondary', 'tertiary' and 'quaternary' props.`

**规则**：Naive UI 的 `<NButton>` 中两组外观属性**互斥**，不可同用：
- 形态组：`text` / `ghost` / `dashed`
- 层级组：`secondary` / `tertiary` / `quaternary`
需二选一。例如要弱化的次要按钮，用 `quaternary` 即可，不要再加 `text`。

### Electron CSP 安全警告

**现象**：控制台报 `Electron Security Warning (Insecure Content-Security-Policy)`。

**规则**：渲染进程 HTML（`src/renderer/index.html`）必须设置 `<meta http-equiv="Content-Security-Policy">`。本项目策略见该文件注释——`connect-src` 需放行 `https:`（AI 服务）+ 本地 dev server；`style-src` 需 `'unsafe-inline'`（Naive UI 内联样式）。修改网络出口或样式方案时要同步更新该 meta。

## 参考

`src/renderer/tokens/tokens.ts` · `src/renderer/composables/useTheme.ts`
