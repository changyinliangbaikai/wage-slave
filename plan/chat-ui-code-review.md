# 聊天主界面重构代码评审报告

> 评审日期：2026-06-30  
> 评审范围：`src/renderer/src/pages/Chat.tsx`、`src/renderer/src/components/chat/*`、`src/renderer/src/pages/agent/*`、`src/renderer/src/hooks/useChat.ts`  
> 评审目标：检查重构后聊天主界面的代码质量、架构合理性、性能与可维护性，并给出优化方案

---

## 一、评审结论总览

| 维度 | 评分 | 说明 |
|------|------|------|
| **功能完整性** | ⭐⭐⭐⭐ | 核心聊天流程完整，Agent 模式工具调用、流式渲染、斜杠命令均可用 |
| **代码质量** | ⭐⭐☆☆☆ | 存在断裂导入、大量死代码、内联样式泛滥、类型安全缺失 |
| **架构设计** | ⭐⭐⭐☆☆ | 组件拆分方向正确但不够彻底，Chat.tsx 仍是 652 行的上帝组件 |
| **性能** | ⭐⭐⭐☆☆ | 存在不必要的全量重渲染与重复 IPC 调用 |
| **可维护性** | ⭐⭐☆☆☆ | 内联样式、硬编码列表、DOM 反模式导致后续维护困难 |

**总体结论**：重构在组件拆分（Sidebar / ChatHeader / FileCard / GitChangeBox）方向正确，但执行不彻底。存在 1 个编译级断裂导入、6 处死代码、大量内联样式和若干性能隐患，需在中期迭代中逐步修复。

---

## 二、问题清单

### 2.1 🔴 严重问题（阻断编译 / 运行时错误）

#### P0-1: ToolCallCard 导入路径断裂

**文件**：`src/renderer/src/pages/agent/ToolCallCard.tsx:2`

```typescript
// 当前（错误）
import type { ToolRunUI } from '../../hooks/useAgent'

// 实际情况：hooks 目录下不存在 useAgent.ts，ToolRunUI 定义在 useChat.ts 中
```

**影响**：TypeScript 编译报错 `Cannot find module '../../hooks/useAgent'`。当前可能因 Vite 的 `verbatimModuleSyntax` 或类型擦除未阻断构建，但属于定时炸弹。

**修复方案**：
```typescript
import type { ToolRunUI } from '../../hooks/useChat'
```

---

### 2.2 🟠 重要问题（死代码 / 未使用状态）

#### P1-1: Chat.tsx 大量未使用导入

**文件**：`src/renderer/src/pages/Chat.tsx:17-46`

以下导入在文件中从未被引用：

| 导入 | 行号 | 说明 |
|------|------|------|
| `createProject as createProjectIPC` | 23 | 项目创建逻辑已移至 Sidebar |
| `deleteProject as deleteProjectIPC` | 24 | 项目删除逻辑已移至 Sidebar |
| `renameProject as renameProjectIPC` | 25 | 项目重命名逻辑已移至 Sidebar |
| `pickProjectDir` | 26 | 目录选择逻辑已移至 Sidebar |
| `openSkills` | 32 | 未使用 |
| `openAgentCron` | 32 | 未使用 |
| `formatTokens` | 38 | 未使用，token 格式化已在 ChatHeader 内联实现 |

**影响**：增加打包体积（tree-shaking 可能消除），降低代码可读性，误导维护者以为这些依赖仍在使用。

#### P1-2: Chat.tsx 死代码函数

**文件**：`src/renderer/src/pages/Chat.tsx:263-273`

```typescript
// handlePick — 定义后从未在 JSX 中使用（Sidebar 的 onLoadSession 回调已替代）
const handlePick = async (id: string) => {
  setShowSessions(false)
  clearAttachments()
  await loadSession(id)
}

// handleDelete — 定义后从未在 JSX 中使用（Sidebar 内部已自行处理删除）
const handleDelete = async (id: string, e: React.MouseEvent) => {
  e.stopPropagation()
  const ok = await deleteChatSession(id)
  if (ok) setSessions(prev => prev.filter(s => s.id !== id))
}
```

#### P1-3: 孤儿状态变量 showSessions / showProjects

**文件**：`src/renderer/src/pages/Chat.tsx:75,163`

```typescript
const [showSessions, setShowSessions] = useState(false)  // 仅在快捷键 effect 中被读写，无对应 UI
const [showProjects, setShowProjects] = useState(false)  // 同上
```

这两个状态原本控制会话历史抽屉和项目管理面板，重构后这些功能已移入 Sidebar 常驻展示，但状态变量和相关的快捷键逻辑（Esc 关闭、Cmd+K 打开历史）仍残留在 Chat.tsx 中。`setShowSessions(true)` 在 Cmd+K 中被调用，但没有任何 UI 组件消费 `showSessions` 值，导致快捷键无效。

**影响**：快捷键 Cmd+K / Esc 关闭抽屉功能实际已失效，用户按 Cmd+K 无任何反应。

---

### 2.3 🟡 中等问题（性能 / 架构 / 可维护性）

#### P2-1: loadAllSessions 依赖 messages.length 导致流式时频繁全量重载

**文件**：`src/renderer/src/pages/Chat.tsx:93-95`

```typescript
useEffect(() => {
  loadAllSessions()
}, [sessionId, projectId, messages.length, running, loadAllSessions])
```

**问题**：`messages.length` 在流式生成过程中每次 chunk 到达都会变化（assistant 消息被 upsert），导致 `loadAllSessions()` 在流式过程中被反复调用，每次都发起 `IPC.CHAT_LIST_SESSIONS` 全量拉取。

**影响**：流式对话期间产生大量无意义的 IPC 调用，在会话数量多时造成性能下降。

**修复方案**：移除 `messages.length` 和 `running` 依赖，仅在会话切换和项目切换时重新加载：

```typescript
useEffect(() => {
  loadAllSessions()
}, [sessionId, projectId, loadAllSessions])
```

若需在新建/删除会话后刷新列表，应在对应操作完成后显式调用 `loadAllSessions()`。

#### P2-2: Sidebar 的 now 时间戳永不更新

**文件**：`src/renderer/src/components/chat/Sidebar.tsx:53`

```typescript
const [now] = useState(() => Date.now())
```

**问题**：`now` 在组件挂载时固定为当前时间，之后永不更新。`formatMetaTime(s.updatedAt, now)` 中的相对时间（如"5分钟前"）会随时间推移变得不准确，直到组件重新挂载。

**修复方案**：使用定时器更新，或改为在渲染时直接计算：

```typescript
// 方案 A：每分钟更新一次
const [now, setNow] = useState(() => Date.now())
useEffect(() => {
  const timer = setInterval(() => setNow(Date.now()), 60_000)
  return () => clearInterval(timer)
}, [])

// 方案 B（更轻量）：在 sessions 发生变化时刷新
const now = Date.now() // 直接在渲染体中计算，每次重渲染都拿到最新值
```

#### P2-3: Sidebar 搜索按钮使用 DOM 反模式

**文件**：`src/renderer/src/components/chat/Sidebar.tsx:188-196`

```typescript
<button onClick={() => {
  const el = document.querySelector('.input-capsule__textarea') as HTMLTextAreaElement
  if (el) {
    el.focus()
    el.value = '/'
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
}}>
  <span>🔍</span> 搜索
</button>
```

**问题**：
1. 直接操作 DOM 违背 React 数据流原则
2. `el.value = '/'` + `dispatchEvent` 不保证触发 React 的受控组件 `onChange`
3. 强依赖 CSS class 名 `.input-capsule__textarea`，重构时易断裂

**修复方案**：通过回调 ref 或状态提升实现：

```typescript
// 在 Chat.tsx 中维护一个 inputFocusRef
const inputFocusRef = useRef<(() => void) | null>(null)

// 传递给 Sidebar
<Sidebar onFocusInput={() => inputFocusRef.current?.()} ... />

// 传递给 AgentInput，注册 focus 方法
<AgentInput ref={inputFocusRef} ... />
```

#### P2-4: Sidebar / ChatHeader 内联样式泛滥

**文件**：`src/renderer/src/components/chat/Sidebar.tsx`、`src/renderer/src/components/chat/ChatHeader.tsx`

**问题**：两个文件中存在大量内联 `style` 属性，例如：

- Sidebar 第 206-258 行：项目标题区按钮的 hover 效果通过 `onMouseOver` / `onMouseOut` 手动修改 `style` 实现
- ChatHeader 第 142-197 行：Token 弹窗的全部样式内联
- Sidebar 第 267-309 行：项目树节点的布局样式内联

**影响**：
1. 无法利用 CSS hover 伪类，需用 JS 事件模拟，性能差且代码冗长
2. 样式无法复用，难以主题化
3. 组件渲染时每次都创建新的 style 对象，导致不必要的重渲染

**修复方案**：将所有内联样式提取到 CSS class，在 `Chat.css` 或独立的 `Sidebar.css` / `ChatHeader.css` 中定义。

#### P2-5: ChatHeader 模型列表硬编码

**文件**：`src/renderer/src/components/chat/ChatHeader.tsx:80-86`

```typescript
const modelsList = [
  'claude-3-5-sonnet-20241022',
  'deepseek-chat',
  'gpt-4o',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
]
```

**问题**：模型列表硬编码在前端，新增模型需改代码重新发版。且与主进程的模型配置可能不同步。

**修复方案**：从主进程动态获取可用模型列表：

```typescript
useEffect(() => {
  window.electronAPI.invoke(IPC.CONFIG_GET_MODELS).then((models: string[]) => {
    setModelsList(models)
  })
}, [])
```

#### P2-6: ChatHeader config 读取使用 any 类型

**文件**：`src/renderer/src/components/chat/ChatHeader.tsx:40`

```typescript
window.electronAPI.invoke(IPC.CONFIG_GET).then((config: any) => {
```

**问题**：`any` 类型绕过了 TypeScript 类型检查，config 结构变更时无编译期保护。

**修复方案**：定义 `AppConfig` 接口并使用：

```typescript
interface AppConfig {
  llm_model?: string
  agent_reasoning_effort?: string
  // ... 其他已知字段
}

window.electronAPI.invoke(IPC.CONFIG_GET).then((config: AppConfig) => {
```

#### P2-7: MessageItem 的 isLastAssistant 判断逻辑有误

**文件**：`src/renderer/src/pages/Chat.tsx:526`

```typescript
const isLastAssistant = onRegenerate != null
```

**问题**：变量名为 `isLastAssistant`（是否是最后一条 assistant 消息），但实际判断的是 `onRegenerate` 是否传入。由于 `Chat.tsx` 第 375 行对所有消息都传入了 `onRegenerate={regenerate}`，这意味着**每一条** assistant 消息的 `isLastAssistant` 都为 `true`，都会渲染操作栏（重新生成按钮、复制按钮、时间戳）。

**影响**：所有 assistant 消息都显示"重新生成"按钮，而非仅最后一条。用户点击中间某条消息的"重新生成"会移除其后所有消息并重新发送，可能造成意外数据丢失。

**修复方案**：在 `Chat.tsx` 中判断是否为最后一条 assistant 消息，并传递给 `MessageItem`：

```typescript
// Chat.tsx 中计算最后一条 assistant 消息的 id
const lastAssistantId = useMemo(() => {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant' && messages[i].iteration !== -1) return messages[i].id
  }
  return null
}, [messages])

// 渲染时传入
messages.map(m => (
  <MessageItem
    key={m.id}
    message={m}
    onRegenerate={m.id === lastAssistantId ? regenerate : undefined}
    canRegenerate={!running}
  />
))
```

#### P2-8: GitChangeBox 使用数组索引作为 key

**文件**：`src/renderer/src/components/chat/GitChangeBox.tsx:61`

```typescript
{visibleFiles.map((file, idx) => (
  <div className="git-file-item" key={idx}>
```

**问题**：使用数组索引 `idx` 作为 React key，当列表展开/收起时元素顺序变化可能导致渲染异常。

**修复方案**：使用文件路径作为 key：

```typescript
{visibleFiles.map((file) => (
  <div className="git-file-item" key={file.path}>
```

#### P2-9: Chat.tsx 上帝组件问题

**文件**：`src/renderer/src/pages/Chat.tsx`（652 行）

**问题**：单个文件包含：
- 主组件 `Chat()`（~400 行）
- `EmptyState` 组件
- `MessageItem` 组件（~120 行，含 `useMemo` 逻辑）
- `ReasoningBlock` 组件
- `ToolRunsBlock` 组件
- `formatTime` / `getMessageCopyText` / `computeTokenInfo` 工具函数
- 内嵌的 Settings 视图

**影响**：文件过大，职责混杂，难以独立测试和复用。

#### P2-10: ChatHeader 读取 config 缺少错误处理

**文件**：`src/renderer/src/components/chat/ChatHeader.tsx:39-46`

```typescript
useEffect(() => {
  window.electronAPI.invoke(IPC.CONFIG_GET).then((config: any) => {
    // ...
  })
}, [])
```

**问题**：Promise 没有 `.catch()` 处理，若 IPC 调用失败会产生 unhandled rejection。

---

### 2.4 🟢 轻微问题（代码风格 / 一致性）

#### P3-1: 导出风格不一致

- `Sidebar.tsx`：`export default function Sidebar()`
- `ChatHeader.tsx`：`export default function ChatHeader()`
- `FileCard.tsx`：`export default function FileCard()`
- `GitChangeBox.tsx`：`export default function GitChangeBox()`
- `AgentInput.tsx`：`export function AgentInput()`（命名导出）
- `ToolCallCard.tsx`：`export function ToolCallCard()`（命名导出）

建议统一为命名导出或默认导出。

#### P3-2: Chat.tsx 多余空行

`Chat.tsx` 第 81-82 行、第 222-223 行存在连续空行，影响可读性。

#### P3-3: Sidebar getShortcutLabel 声明但无实际快捷键实现

**文件**：`src/renderer/src/components/chat/Sidebar.tsx:79-82`

```typescript
const getShortcutLabel = (index: number): string | null => {
  if (index === 0) return '⌘9'
  return null
}
```

仅展示 `⌘9` 标签，但无对应的 `⌘9` 快捷键绑定逻辑，属于"装饰性"提示，可能误导用户。

#### P3-4: FileCard 使用 select 元素作为"打开方式"按钮

**文件**：`src/renderer/src/components/chat/FileCard.tsx:27-35`

使用 `<select>` 模拟下拉菜单操作不直观，且 `e.target.value = 'default'` 直接操作 DOM 重置 select 值，属于 React 反模式。

#### P3-5: formatMetaTime 不处理负值（未来时间戳）

**文件**：`src/renderer/src/components/chat/Sidebar.tsx:15-26`

当 `ts > now` 时 `diff` 为负，`mins` 为负，`Math.max(1, mins)` 返回 1，显示"1分钟前"，语义不正确。

#### P3-6: ChatHeader 两个下拉菜单共用同一 className

**文件**：`src/renderer/src/components/chat/ChatHeader.tsx:203,229`

模型选择器和推理强度选择器都使用 `codex-header__model-selector-wrapper` 和 `codex-header__model-btn`，样式耦合，修改其中一个会影响另一个。

---

## 三、优化方案

### 阶段一：紧急修复（预计 0.5 天）

#### 3.1.1 修复 ToolCallCard 断裂导入

**文件**：`src/renderer/src/pages/agent/ToolCallCard.tsx`

```diff
- import type { ToolRunUI } from '../../hooks/useAgent'
+ import type { ToolRunUI } from '../../hooks/useChat'
```

#### 3.1.2 清理 Chat.tsx 死代码

1. 移除未使用的导入（`createProjectIPC`、`deleteProjectIPC`、`renameProjectIPC`、`pickProjectDir`、`openSkills`、`openAgentCron`、`formatTokens`）
2. 移除 `handlePick`、`handleDelete` 函数
3. 移除 `showSessions`、`showProjects` 状态变量
4. 移除对应的快捷键 effect 中对 `showSessions`/`showProjects` 的引用
5. 若需保留 Cmd+K 快捷键功能，改为聚焦输入框并触发斜杠菜单

#### 3.1.3 修复 MessageItem isLastAssistant 判断

在 `Chat.tsx` 中计算最后一条 assistant 消息 id，仅对该消息传递 `onRegenerate`：

```typescript
const lastAssistantId = useMemo(() => {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant' && messages[i].iteration !== -1) return messages[i].id
  }
  return null
}, [messages])

// JSX 中
messages.map(m => (
  <MessageItem
    key={m.id}
    message={m}
    onRegenerate={m.id === lastAssistantId ? regenerate : undefined}
    canRegenerate={!running}
  />
))
```

#### 3.1.4 修复 loadAllSessions 依赖

```diff
  useEffect(() => {
    loadAllSessions()
- }, [sessionId, projectId, messages.length, running, loadAllSessions])
+ }, [sessionId, projectId, loadAllSessions])
```

在 `onRename`、`onDelete`、`onCompact` 等操作完成后显式调用 `loadAllSessions()`。

#### 3.1.5 修复 GitChangeBox key

```diff
- {visibleFiles.map((file, idx) => (
-   <div className="git-file-item" key={idx}>
+ {visibleFiles.map((file) => (
+   <div className="git-file-item" key={file.path}>
```

---

### 阶段二：架构优化（预计 2-3 天）

#### 3.2.1 拆分 Chat.tsx 上帝组件

将 `Chat.tsx` 中的子组件和工具函数拆分为独立文件：

```
src/renderer/src/
├── pages/
│   └── Chat.tsx                    # 仅保留主组件编排逻辑（目标 < 200 行）
├── components/
│   └── chat/
│       ├── Sidebar.tsx             # 已拆分 ✓
│       ├── ChatHeader.tsx          # 已拆分 ✓
│       ├── FileCard.tsx            # 已拆分 ✓
│       ├── GitChangeBox.tsx        # 已拆分 ✓
│       ├── MessageItem.tsx         # 新建：从 Chat.tsx 拆出
│       ├── EmptyState.tsx          # 新建：从 Chat.tsx 拆出
│       ├── ReasoningBlock.tsx      # 新建：从 Chat.tsx 拆出
│       ├── ToolRunsBlock.tsx       # 新建：从 Chat.tsx 拆出
│       └── SettingsView.tsx        # 新建：从 Chat.tsx 拆出设置视图
├── utils/
│   ├── format-tokens.ts            # 已存在
│   ├── format-time.ts              # 新建：从 Chat.tsx 拆出 formatTime
│   └── chat-helpers.ts             # 新建：computeTokenInfo, getMessageCopyText
```

**拆分原则**：
- `MessageItem` 是最复杂的子组件（~120 行），含 `useMemo` 编辑文件提取逻辑，应独立文件
- `EmptyState`、`ReasoningBlock`、`ToolRunsBlock` 虽简单但独立后便于复用和测试
- `SettingsView` 封装设置页的内嵌头部和滚动容器

#### 3.2.2 提取 Sidebar / ChatHeader 内联样式

**目标**：将所有内联 `style` 属性迁移到 CSS class

**新建文件**：`src/renderer/src/components/chat/Sidebar.css`

需提取的样式清单：

| 组件位置 | 当前实现 | 目标 CSS class |
|----------|----------|----------------|
| 项目标题区按钮 | `onMouseOver`/`onMouseOut` + `style` | `.sidebar-add-project-btn` + `:hover` |
| 收起全部按钮 | `onMouseOut` + `style` | `.sidebar-collapse-all-btn` + `:hover` |
| 项目树节点布局 | `style={{ display: 'flex', ... }}` | `.project-folder-node` |
| 项目文件夹图标 | `style={{ flexShrink: 0 }}` | `.project-folder-icon` |
| 会话空状态 | `style={{ padding: '4px 10px', ... }}` | `.session-node-empty` |
| 新建对话按钮 | `style={{ background: 'none', ... }}` | `.sidebar-add-chat-btn` |

**新建文件**：`src/renderer/src/components/chat/ChatHeader.css`

需提取的样式清单：

| 组件位置 | 目标 CSS class |
|----------|----------------|
| Token 环形图容器 | `.context-ring-wrapper` |
| Token 弹窗 | `.codex-header__token-popover` |
| Token 弹窗内各项 | `.token-popover__row`, `.token-popover__label`, `.token-popover__value` |

#### 3.2.3 修复 Sidebar 搜索按钮 DOM 反模式

**方案**：通过 ref 回调实现跨组件聚焦

```typescript
// Chat.tsx
const focusInputRef = useRef<(() => void) | null>(null)

<AgentInput
  {...}
  registerFocus={(fn: () => void) => { focusInputRef.current = fn }}
/>

<Sidebar
  {...}
  onSearchClick={() => focusInputRef.current?.()}
/>

// AgentInput.tsx
useImperativeHandle 或 registerFocus prop:
registerFocus?.(() => {
  const ta = ref.current
  if (ta) {
    ta.focus()
    onChange('/')
  }
})
```

#### 3.2.4 模型列表动态化

**主进程侧**：新增 IPC 通道 `CONFIG_GET_MODELS`，返回当前可用模型列表

**渲染端**：

```typescript
// ChatHeader.tsx
const [modelsList, setModelsList] = useState<string[]>([])

useEffect(() => {
  window.electronAPI.invoke(IPC.CONFIG_GET_MODELS)
    .then((models: string[]) => setModelsList(models))
    .catch(() => setModelsList(['claude-3-5-sonnet-20241022'])) // fallback
}, [])
```

---

### 阶段三：性能与体验优化（预计 1-2 天）

#### 3.3.1 Sidebar 相对时间自动刷新

```typescript
// Sidebar.tsx
const [now, setNow] = useState(() => Date.now())
useEffect(() => {
  const timer = setInterval(() => setNow(Date.now()), 60_000)
  return () => clearInterval(timer)
}, [])
```

#### 3.3.2 Sidebar 会话列表 memo 化

```typescript
// 当前：每次渲染都重新 filter
const standaloneSessions = sessions.filter(s => !s.projectId || s.projectId === 'default')
const getProjectSessions = (projId: string) => sessions.filter(s => s.projectId === projId)

// 优化：使用 useMemo
const standaloneSessions = useMemo(
  () => sessions.filter(s => !s.projectId || s.projectId === 'default'),
  [sessions]
)

const projectSessionsMap = useMemo(() => {
  const map = new Map<string, ChatSessionMeta[]>()
  for (const s of sessions) {
    if (!s.projectId || s.projectId === 'default') continue
    const list = map.get(s.projectId) ?? []
    list.push(s)
    map.set(s.projectId, list)
  }
  return map
}, [sessions])

// 使用时
const projSessions = projectSessionsMap.get(p.id) ?? []
```

#### 3.3.3 ChatHeader 外部点击处理统一化

当前 `ChatHeader` 有 4 个独立的 ref 和一个统一的 `handleOutsideClick`，逻辑正确但冗长。可抽取为自定义 Hook：

```typescript
// hooks/useClickOutside.ts
export function useClickOutside<T extends HTMLElement>(
  active: boolean,
  onOutside: () => void
): RefObject<T> {
  const ref = useRef<T>(null)
  useEffect(() => {
    if (!active) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onOutside()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [active, onOutside])
  return ref
}
```

在 `ChatHeader` 中使用：

```typescript
const modelMenuRef = useClickOutside<HTMLDivElement>(showModelMenu, () => setShowModelMenu(false))
const effortMenuRef = useClickOutside<HTMLDivElement>(showEffortMenu, () => setShowEffortMenu(false))
// ...
```

#### 3.3.4 ChatHeader config 读取添加错误处理

```typescript
useEffect(() => {
  window.electronAPI.invoke(IPC.CONFIG_GET)
    .then((config: AppConfig) => {
      if (config) {
        if (config.llm_model) setModelName(config.llm_model)
        setReasoningEffort(config.agent_reasoning_effort || '')
      }
    })
    .catch((err) => {
      console.error('[ChatHeader] Failed to load config:', err)
    })
}, [])
```

#### 3.3.5 FileCard 打开方式改为下拉菜单组件

将 `<select>` 替换为轻量弹出菜单：

```typescript
function FileCard({ name, truncated }: FileCardProps) {
  const [showMenu, setShowMenu] = useState(false)

  return (
    <div className="codex-file-card">
      {/* ... */}
      <div className="file-card__actions">
        <button onClick={() => setShowMenu(!showMenu)}>打开方式 ▾</button>
        {showMenu && (
          <div className="file-card__menu">
            <button onClick={() => { handleOpen(); setShowMenu(false) }}>
              系统默认打开
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
```

---

### 阶段四：类型安全与代码规范（预计 1 天）

#### 3.4.1 定义 AppConfig 类型接口

```typescript
// shared/types-config.ts（新建）
export interface AppConfig {
  llm_model?: string
  agent_llm_model?: string
  agent_reasoning_effort?: string
  api_key?: string
  api_base_url?: string
  // ... 其他已知配置项
}
```

在 `ChatHeader.tsx` 和 `useChat.ts` 中使用 `AppConfig` 替代 `any` / `Record<string, unknown>`。

#### 3.4.2 统一导出风格

建议全部使用**命名导出**（`export function Xxx`），便于 IDE 自动导入和 tree-shaking：

```typescript
// Sidebar.tsx
export function Sidebar({ ... }: SidebarProps) { ... }

// ChatHeader.tsx
export function ChatHeader({ ... }: ChatHeaderProps) { ... }
```

#### 3.4.3 移除 getShortcutLabel 或实现完整快捷键

若不打算实现 `⌘9` 快捷键，移除 `getShortcutLabel` 函数和对应的 `⌘9` 显示。若要实现，在 `Chat.tsx` 中添加：

```typescript
useEffect(() => {
  const onKey = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key >= '1' && e.key <= '9') {
      const idx = parseInt(e.key) - 1
      // 获取当前可见会话列表并切换到第 idx 个
    }
  }
  window.addEventListener('keydown', onKey)
  return () => window.removeEventListener('keydown', onKey)
}, [sessions])
```

#### 3.4.4 修复 formatMetaTime 边界

```typescript
function formatMetaTime(ts: number, now: number): string {
  const diff = now - ts
  if (diff < 0) return '刚刚'        // 未来时间戳兜底
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return '刚刚'        // 不足 1 分钟
  if (mins < 60) return `${mins}分钟前`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}小时前`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}天前`
  const weeks = Math.floor(days / 7)
  return `${weeks}周前`
}
```

---

## 四、优化优先级与排期

| 优先级 | 阶段 | 任务 | 预计工时 | 风险 |
|--------|------|------|----------|------|
| **P0** | 阶段一 | 修复 ToolCallCard 断裂导入 | 5 分钟 | 低 |
| **P0** | 阶段一 | 修复 MessageItem isLastAssistant 逻辑 | 15 分钟 | 低 |
| **P1** | 阶段一 | 清理 Chat.tsx 死代码与未使用导入 | 30 分钟 | 低 |
| **P1** | 阶段一 | 修复 loadAllSessions 依赖 | 10 分钟 | 低 |
| **P1** | 阶段一 | 修复 GitChangeBox key | 5 分钟 | 低 |
| **P2** | 阶段二 | 拆分 Chat.tsx 子组件到独立文件 | 1 天 | 中 |
| **P2** | 阶段二 | 提取 Sidebar / ChatHeader 内联样式 | 0.5 天 | 低 |
| **P2** | 阶段二 | 修复 Sidebar 搜索按钮 DOM 反模式 | 2 小时 | 中 |
| **P2** | 阶段二 | 模型列表动态化 | 3 小时 | 中 |
| **P3** | 阶段三 | Sidebar 相对时间自动刷新 | 30 分钟 | 低 |
| **P3** | 阶段三 | Sidebar 会话列表 memo 化 | 1 小时 | 低 |
| **P3** | 阶段三 | 提取 useClickOutside Hook | 1 小时 | 低 |
| **P3** | 阶段三 | ChatHeader config 错误处理 | 15 分钟 | 低 |
| **P3** | 阶段三 | FileCard 打开方式重构 | 1 小时 | 低 |
| **P4** | 阶段四 | 定义 AppConfig 类型 | 1 小时 | 低 |
| **P4** | 阶段四 | 统一导出风格 | 30 分钟 | 低 |
| **P4** | 阶段四 | 移除/实现 getShortcutLabel | 30 分钟 | 低 |
| **P4** | 阶段四 | 修复 formatMetaTime 边界 | 10 分钟 | 低 |

**总计**：约 4-5 个工作日

---

## 五、文件变更清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `pages/agent/ToolCallCard.tsx` | 修改 | 修复导入路径 |
| `pages/Chat.tsx` | 修改 | 清理死代码、修复 isLastAssistant、修复 loadAllSessions 依赖 |
| `components/chat/GitChangeBox.tsx` | 修改 | 修复 key |
| `components/chat/MessageItem.tsx` | 新建 | 从 Chat.tsx 拆出 |
| `components/chat/EmptyState.tsx` | 新建 | 从 Chat.tsx 拆出 |
| `components/chat/ReasoningBlock.tsx` | 新建 | 从 Chat.tsx 拆出 |
| `components/chat/ToolRunsBlock.tsx` | 新建 | 从 Chat.tsx 拆出 |
| `components/chat/SettingsView.tsx` | 新建 | 从 Chat.tsx 拆出设置视图 |
| `components/chat/Sidebar.tsx` | 修改 | 移除内联样式、修复搜索按钮、memo 化、时间刷新 |
| `components/chat/Sidebar.css` | 新建 | Sidebar 样式 |
| `components/chat/ChatHeader.tsx` | 修改 | 移除内联样式、模型列表动态化、类型安全、错误处理 |
| `components/chat/ChatHeader.css` | 新建 | ChatHeader 样式 |
| `components/chat/FileCard.tsx` | 修改 | 重构打开方式 UI |
| `hooks/useClickOutside.ts` | 新建 | 通用外部点击 Hook |
| `utils/format-time.ts` | 新建 | 从 Chat.tsx 拆出 formatTime |
| `utils/chat-helpers.ts` | 新建 | 从 Chat.tsx 拆出 computeTokenInfo, getMessageCopyText |
| `shared/types-config.ts` | 新建 | AppConfig 类型定义 |

---

## 六、测试验证要点

1. **编译验证**：`npm run build` 确认无 TypeScript 错误
2. **功能回归**：
   - 发送消息 → 流式渲染 → 工具调用卡片 → 完成
   - 斜杠命令 `/help`、`/plan`、`/model`、`/compact`
   - 侧边栏项目切换、会话切换、新建会话
   - 拖拽文件添加附件
   - 设置页打开/返回
   - 模型切换、推理强度切换
3. **性能验证**：流式对话期间观察 IPC 调用频率，确认 `CHAT_LIST_SESSIONS` 不再被频繁调用
4. **UI 验证**：确认仅最后一条 assistant 消息显示"重新生成"按钮
