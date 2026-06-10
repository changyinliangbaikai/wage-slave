# AI 对话与 Agent 模式合并重构计划（方案2）

> **目标**：彻底重构统一架构，将 AI 快速对话和 Agent 工具模式合并为统一的对话系统
> **预计工期**：5-7 天
> **优先级**：中等（功能完善后执行）

---

## 1. 架构总览

### 1.1 当前架构问题

```
当前状态（两套独立系统）：
┌─────────────────┐     ┌─────────────────┐
│   AIChat 模式   │     │   Agent 模式    │
├─────────────────┤     ├─────────────────┤
│ ai-chat-service │     │ orchestrator.ts │
│ AIChatSession   │     │ AgentSession    │
│ AIChatMessage   │     │ AgentMessage    │
│ useAIChat.ts    │     │ useAgent.ts     │
│ AIChat.tsx      │     │ AgentChat.tsx   │
│ 7 个 IPC 通道   │     │ 12 个 IPC 通道  │
└─────────────────┘     └─────────────────┘
        ↓                       ↓
   独立窗口/入口          独立窗口/入口
   
问题：
1. 代码重复（两套 SSE 流式处理、两套存储逻辑）
2. 用户体验割裂（需要选择模式）
3. 维护成本高（改动需要同步两套系统）
4. 数据不互通（历史记录分散）
```

### 1.2 目标架构

```
目标状态（统一架构）：
┌─────────────────────────────────────────┐
│           统一对话系统                  │
├─────────────────────────────────────────┤
│  ┌─────────────┐     ┌─────────────┐  │
│  │ 简单对话模式 │     │ Agent 工具   │  │
│  │ (no tools)  │     │ 模式        │  │
│  └──────┬──────┘     └──────┬──────┘  │
│         │                   │         │
│         └─────────┬─────────┘         │
│                   │                   │
│        ┌──────────▼──────────┐       │
│        │   DialogueService   │       │
│        │   (统一服务层)       │       │
│        └──────────┬──────────┘       │
│                   │                   │
│        ┌──────────▼──────────┐       │
│        │   ChatSessionStore  │       │
│        │   (统一存储层)       │       │
│        └──────────────────────┘       │
└─────────────────────────────────────────┘

统一类型：ChatMessage, ChatSession, ChatRole
统一 IPC：CHAT_*（精简为 8 个通道）
统一 UI：ChatWindow（根据模式切换视图）
```

---

## 2. 详细改造计划

### Phase 1: 类型系统统一（1 天）

#### 2.1.1 设计新的统一类型

**文件**: `src/shared/types-chat.ts` (新建)

```typescript
// 统一的角色类型
export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'

// 统一的消息类型（兼容简单对话和 Agent 工具）
export interface ChatMessage {
  id: string
  role: ChatRole
  content: string
  // Agent 模式特有字段（可选）
  toolCalls?: ToolCall[]           // assistant 消息的工具调用
  toolResults?: ToolResult[]       // tool 角色的结果
  reasoning?: string               // 思考过程（R1 等模型）
  metadata?: {
    model?: string
    tokens?: number
    latency?: number
    iteration?: number             // Agent 第几轮
  }
  createdAt: number
}

// 统一的会话类型
export interface ChatSession {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
  // 会话配置
  config: {
    mode: 'chat' | 'agent'         // 关键：区分简单对话和 Agent 模式
    model: string
    temperature?: number
    maxIterations?: number          // Agent 最大迭代数
    systemPrompt?: string
  }
  // 统计信息
  stats?: {
    totalTokens: number
    totalToolCalls: number
    totalIterations: number
    avgLatency: number
  }
}

// 工具调用类型
export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
  status: 'pending' | 'running' | 'success' | 'error'
  result?: string
  error?: string
  durationMs?: number
}
```

#### 2.1.2 废弃旧类型（保留别名兼容）

**文件**: `src/shared/types.ts` (修改)

```typescript
// 保留别名以兼容旧代码（逐步迁移）
/** @deprecated 使用 ChatMessage */
export type AIChatMessage = ChatMessage
/** @deprecated 使用 ChatMessage */
export type AgentMessage = ChatMessage
/** @deprecated 使用 ChatSession */
export type AIChatSession = ChatSession
/** @deprecated 使用 ChatSession */
export type AgentSession = ChatSession
```

### Phase 2: 后端服务重构（2 天）

#### 2.2.1 抽象对话服务接口

**文件**: `src/main/chat/dialogue-service.ts` (新建)

```typescript
/**
 * 统一对话服务
 * 
 * 职责：
 * 1. 根据会话 mode 自动选择执行策略
 *    - 'chat' -> 单轮流式对话
 *    - 'agent' -> 多轮迭代 + 工具调用
 * 2. 统一的 SSE 流式处理
 * 3. 统一的 Token 计算和统计
 */

export interface DialogueCallbacks {
  onChunk: (payload: ChatChunkPayload) => void
  onDone: (payload: ChatDonePayload) => void
  onError: (payload: ChatErrorPayload) => void
  // Agent 模式特有
  onToolStart?: (payload: ToolStartPayload) => void
  onToolExecuting?: (payload: ToolExecutingPayload) => void
  onToolExecuted?: (payload: ToolExecutedPayload) => void
}

export interface DialogueOptions {
  sessionId: string
  userInput: string
  apiKey: string
  // 从会话配置读取，但可覆盖
  mode?: 'chat' | 'agent'
  maxIterations?: number
}

export class DialogueService {
  private orchestrator: AgentOrchestrator | null = null
  private simpleChat: SimpleChatService | null = null
  
  async start(options: DialogueOptions, callbacks: DialogueCallbacks): Promise<void> {
    const session = await chatStore.getSession(options.sessionId)
    const mode = options.mode || session.config.mode
    
    if (mode === 'agent') {
      // 使用 Agent 编排器
      this.orchestrator = new AgentOrchestrator(options.sessionId)
      await this.orchestrator.run({
        userInput: options.userInput,
        apiKey: options.apiKey,
        history: session.messages,
        callbacks: this.adaptCallbacks(callbacks)
      })
    } else {
      // 使用简单对话服务（复用 ai-chat-service.ts 逻辑）
      this.simpleChat = new SimpleChatService()
      await this.simpleChat.chat({
        requestId: options.sessionId,
        messages: [...session.messages, { role: 'user', content: options.userInput }],
        callbacks: this.adaptCallbacks(callbacks)
      })
    }
  }
  
  abort(): void {
    this.orchestrator?.abort()
    this.simpleChat?.abort()
  }
}
```

#### 2.2.2 重构存储层

**文件**: `src/main/chat/chat-store.ts` (新建，合并 ai-chat-store.ts 和 session-store.ts)

```typescript
/**
 * 统一对话存储
 * 
 * 存储路径：
 * - 快速对话: userData/chats/{date}/{sessionId}.json
 * - 结构化存储，便于搜索和导出
 */

const CHATS_DIR = path.join(app.getPath('userData'), 'chats')

export class ChatStore {
  // 内存缓存（活跃会话）
  private activeSessions = new Map<string, ChatSession>()
  
  // 获取会话
  async getSession(id: string): Promise<ChatSession | null>
  
  // 保存会话
  async saveSession(session: ChatSession): Promise<void>
  
  // 列出所有会话
  async listSessions(): Promise<ChatSessionMeta[]>
  
  // 删除会话
  async deleteSession(id: string): Promise<boolean>
  
  // 搜索会话内容
  async searchSessions(query: string): Promise<ChatSession[]>
  
  // 数据迁移：从旧格式导入
  async migrateFromLegacy(
    aiChatSessions: AIChatSession[],
    agentSessions: AgentSession[]
  ): Promise<void>
}
```

#### 2.2.3 精简 IPC 通道

**文件**: `src/shared/ipc-channels.ts` (修改)

```typescript
// 废弃旧的 IPC 通道
// AI_CHAT_* -> 废弃
// AGENT_* -> 废弃

// 新的统一 IPC 通道
export const IPC = {
  // ── 统一对话系统 ──────────────────────────
  
  // 发起对话（chat 或 agent 模式）
  CHAT_START: 'renderer:chat-start',
  // 中止当前对话
  CHAT_STOP: 'renderer:chat-stop',
  
  // 流式推送
  CHAT_CHUNK: 'main:chat-chunk',      // 文本/思考增量
  CHAT_TOOL_EVENT: 'main:chat-tool-event', // 工具调用状态
  CHAT_DONE: 'main:chat-done',        // 完成（含统计）
  CHAT_ERROR: 'main:chat-error',      // 错误
  
  // 会话管理
  CHAT_LIST_SESSIONS: 'renderer:chat-list-sessions',
  CHAT_GET_SESSION: 'renderer:chat-get-session',
  CHAT_SAVE_SESSION: 'renderer:chat-save-session',
  CHAT_DELETE_SESSION: 'renderer:chat-delete-session',
  CHAT_SEARCH: 'renderer:chat-search',
  
  // 窗口控制
  CHAT_OPEN_WINDOW: 'renderer:chat-open-window',
}
```

**文件**: `src/main/ipc-handlers-chat.ts` (新建，合并 IPC 处理)

```typescript
// 统一处理所有对话相关的 IPC
export function registerChatIPC(): void {
  // 启动对话
  ipcMain.handle(IPC.CHAT_START, async (_, options) => {
    const service = new DialogueService()
    // ... 流式回调处理
  })
  
  // 中止对话
  ipcMain.handle(IPC.CHAT_STOP, async (_, sessionId) => {
    // ... 中止逻辑
  })
  
  // 会话 CRUD...
}
```

### Phase 3: 前端重构（2 天）

#### 2.3.1 统一 Hook

**文件**: `src/renderer/src/hooks/useChat.ts` (新建，合并 useAIChat.ts 和 useAgent.ts)

```typescript
/**
 * 统一对话 Hook
 * 
 * 功能：
 * 1. 管理会话状态（消息列表、当前模式、运行状态）
 * 2. 发送消息（自动根据模式选择执行策略）
 * 3. 流式增量处理
 * 4. 工具调用面板
 */

export interface UseChatResult {
  sessionId: string
  messages: ChatMessage[]
  mode: 'chat' | 'agent'
  isRunning: boolean
  currentTool: string | null
  
  // 核心操作
  sendMessage: (content: string, mode?: 'chat' | 'agent') => Promise<void>
  stopGeneration: () => Promise<void>
  
  // 会话管理
  newSession: (mode?: 'chat' | 'agent') => void
  loadSession: (id: string) => Promise<void>
  switchMode: (mode: 'chat' | 'agent') => void
  
  // 工具调用（Agent 模式）
  toolRuns: ToolRunUI[]
}

export function useChat(): UseChatResult {
  // 合并 useAIChat 和 useAgent 的逻辑
  // 根据 session.config.mode 决定如何处理流式响应
}
```

#### 2.3.2 统一页面组件

**文件**: `src/renderer/src/pages/Chat.tsx` (新建，合并 AIChat.tsx 和 AgentChat.tsx)

```typescript
/**
 * 统一对话页面
 * 
 * 布局：
 * ┌──────────────────────────────────────────────────────┐
 * │ 顶部：模式切换 [聊天 ▼] | 标题 | 新建/历史/设置     │
 * ├──────────────────────────────────────────────────────┤
 * │                                                      │
 * │ 消息列表（根据模式显示不同卡片）                     │
 * │ - chat: 简单文本消息                               │
 * │ - agent: 文本 + 工具调用卡片                        │
 * │                                                      │
 * ├──────────────────────────────────────────────────────┤
 * │ 输入区（textarea + 发送/停止/模式切换）            │
 * └──────────────────────────────────────────────────────┘
 */

export default function Chat() {
  const {
    sessionId,
    messages,
    mode,
    isRunning,
    currentTool,
    sendMessage,
    stopGeneration,
    newSession,
    loadSession,
    switchMode,
    toolRuns
  } = useChat()
  
  return (
    <div className="chat-container">
      {/* 顶部栏：模式切换 */}
      <ChatHeader
        mode={mode}
        onSwitchMode={switchMode}
        sessionId={sessionId}
        onNewSession={newSession}
        onShowHistory={() => setShowSessions(true)}
      />
      
      {/* 消息列表：根据消息类型渲染不同组件 */}
      <MessageList
        messages={messages}
        mode={mode}
        isRunning={isRunning}
        toolRuns={toolRuns}
      />
      
      {/* 输入区 */}
      <ChatInput
        onSend={sendMessage}
        onStop={stopGeneration}
        isRunning={isRunning}
        mode={mode}
      />
    </div>
  )
}
```

#### 2.3.3 消息渲染组件

**文件**: `src/renderer/src/components/chat/MessageItem.tsx` (新建)

```typescript
/**
 * 统一消息渲染组件
 * 
 * 根据消息内容和会话模式智能渲染：
 * - 纯文本：Markdown 渲染
 * - 工具调用：ToolCallCard（Agent 模式）
 * - 思考过程：可折叠的 reasoning 块
 */

interface MessageItemProps {
  message: ChatMessage
  mode: 'chat' | 'agent'
}

export function MessageItem({ message, mode }: MessageItemProps) {
  if (message.role === 'tool') {
    return <ToolResultCard result={message.content} />
  }
  
  if (message.role === 'assistant' && message.toolCalls) {
    return (
      <div className="assistant-message">
        {/* 思考过程（可折叠） */}
        {message.reasoning && (
          <ReasoningBlock content={message.reasoning} />
        )}
        
        {/* 正文 */}
        <MarkdownContent content={message.content} />
        
        {/* 工具调用卡片（Agent 模式） */}
        {mode === 'agent' && message.toolCalls.map(tool => (
          <ToolCallCard key={tool.id} tool={tool} />
        ))}
      </div>
    )
  }
  
  // 普通消息
  return <MarkdownContent content={message.content} />
}
```

### Phase 4: 数据迁移（1 天）

#### 2.4.1 迁移脚本

**文件**: `src/main/migrations/merge-chat-sessions.ts` (新建)

```typescript
/**
 * 会话数据迁移
 * 
 * 将 AIChatSession 和 AgentSession 统一转换为 ChatSession
 */

export async function migrateChatSessions(): Promise<void> {
  const chatStore = new ChatStore()
  
  // 1. 读取旧数据
  const aiChatSessions = await loadLegacyAIChatSessions()
  const agentSessions = await loadLegacyAgentSessions()
  
  // 2. 转换格式
  for (const old of aiChatSessions) {
    const migrated: ChatSession = {
      id: old.id,
      title: old.title,
      createdAt: old.createdAt,
      updatedAt: old.updatedAt || old.createdAt,
      messages: old.messages.map(m => ({
        id: m.id,
        role: m.role === 'system' ? 'system' : 
              m.role === 'user' ? 'user' : 'assistant',
        content: m.content,
        createdAt: m.createdAt || old.createdAt
      })),
      config: {
        mode: 'chat',
        model: 'deepseek-v3', // 默认模型
      }
    }
    await chatStore.saveSession(migrated)
  }
  
  // 3. 迁移 Agent 会话
  for (const old of agentSessions) {
    const migrated: ChatSession = {
      id: old.id,
      title: old.title,
      createdAt: old.createdAt,
      updatedAt: old.updatedAt || old.createdAt,
      messages: old.messages.map(m => ({
        id: m.id,
        role: m.role,
        content: m.content,
        toolCalls: m.toolCalls,
        toolResults: m.toolResults,
        reasoning: m.reasoning,
        metadata: {
          iteration: m.iteration
        },
        createdAt: m.createdAt
      })),
      config: {
        mode: 'agent',
        model: 'deepseek-v3',
        maxIterations: 20
      },
      stats: {
        totalTokens: old.stats?.totalTokens || 0,
        totalToolCalls: old.stats?.toolCalls || 0,
        totalIterations: old.stats?.iterations || 0,
        avgLatency: 0
      }
    }
    await chatStore.saveSession(migrated)
  }
  
  // 4. 标记迁移完成
  await markMigrationComplete('v2.2.0-merge-chat')
}
```

#### 2.4.2 启动时自动迁移

**文件**: `src/main/index.ts` (修改)

```typescript
app.whenReady().then(async () => {
  // ... 其他初始化
  
  // 数据迁移
  if (!hasMigrationCompleted('v2.2.0-merge-chat')) {
    console.log('[Main] 执行会话数据迁移...')
    await migrateChatSessions()
    console.log('[Main] 数据迁移完成')
  }
  
  // ... 启动窗口
})
```

### Phase 5: 清理废弃代码（1 天）

#### 2.5.1 删除/归档文件

| 废弃文件 | 处理方式 | 说明 |
|---------|---------|------|
| `src/main/ai-chat-service.ts` | 删除 | 逻辑合并到 DialogueService |
| `src/main/ai-chat-store.ts` | 删除 | 合并到 chat-store.ts |
| `src/main/agent/session-store.ts` | 删除 | 合并到 chat-store.ts |
| `src/main/agent/orchestrator.ts` | 保留重命名 | 作为 DialogueService 的子模块 |
| `src/renderer/src/hooks/useAIChat.ts` | 删除 | 合并到 useChat.ts |
| `src/renderer/src/hooks/useAgent.ts` | 删除 | 合并到 useChat.ts |
| `src/renderer/src/pages/AIChat.tsx` | 删除 | 合并到 Chat.tsx |
| `src/renderer/src/pages/AgentChat.tsx` | 删除 | 合并到 Chat.tsx |
| `src/renderer/src/pages/AIChat.css` | 合并后删除 | 样式合并到 Chat.css |
| `src/renderer/src/pages/AgentChat.css` | 合并后删除 | 样式合并到 Chat.css |

#### 2.5.2 路由更新

**文件**: `src/renderer/src/App.tsx` (修改)

```typescript
// 旧路由
<Route path="/ai-chat" element={<AIChat />} />
<Route path="/agent" element={<AgentChat />} />

// 新路由（统一入口）
<Route path="/chat" element={<Chat />} />
// 保留重定向兼容
<Route path="/ai-chat" element={<Navigate to="/chat?mode=chat" />} />
<Route path="/agent" element={<Navigate to="/chat?mode=agent" />} />
```

---

## 3. 文件变更清单

### 新建文件（12 个）

```
src/shared/types-chat.ts              # 统一类型定义
src/main/chat/dialogue-service.ts      # 统一对话服务
src/main/chat/simple-chat-service.ts   # 简单对话服务（原 ai-chat-service 逻辑）
src/main/chat/chat-store.ts            # 统一存储层
src/main/chat/ipc-handlers-chat.ts     # 统一 IPC 处理器
src/main/migrations/merge-chat-sessions.ts  # 数据迁移脚本
src/renderer/src/hooks/useChat.ts      # 统一 Hook
src/renderer/src/pages/Chat.tsx        # 统一页面
src/renderer/src/pages/Chat.css        # 统一样式
src/renderer/src/components/chat/
  ├── MessageItem.tsx                 # 消息渲染组件
  ├── ChatHeader.tsx                  # 顶部栏组件
  ├── ChatInput.tsx                   # 输入区组件
  ├── MessageList.tsx                 # 消息列表组件
  ├── ToolCallCard.tsx                # 工具调用卡片（从 agent/ 移动）
  └── ReasoningBlock.tsx              # 思考过程块
```

### 修改文件（4 个）

```
src/shared/types.ts                    # 添加类型别名兼容
src/shared/ipc-channels.ts            # 精简 IPC 通道
src/main/index.ts                      # 添加迁移逻辑
src/renderer/src/App.tsx               # 更新路由
```

### 删除/归档文件（11 个）

```
src/main/ai-chat-service.ts            # 逻辑合并后删除
src/main/ai-chat-store.ts              # 合并后删除
src/main/agent/session-store.ts        # 合并后删除
src/renderer/src/hooks/useAIChat.ts    # 合并后删除
src/renderer/src/hooks/useAgent.ts     # 合并后删除
src/renderer/src/pages/AIChat.tsx     # 合并后删除
src/renderer/src/pages/AIChat.css      # 合并后删除
src/renderer/src/pages/AgentChat.tsx   # 合并后删除
src/renderer/src/pages/AgentChat.css   # 合并后删除
src/renderer/src/pages/agent/         # 部分组件移动到 components/chat/
```

---

## 4. 风险与应对

### 4.1 主要风险

| 风险 | 影响 | 应对措施 |
|-----|------|---------|
| 数据迁移失败 | 高 | 1. 迁移前自动备份<br>2. 迁移失败可回滚<br>3. 分批次迁移 |
| 功能回归 | 高 | 1. 保留旧代码备份<br>2. 完整功能测试<br>3. 灰度发布 |
| 性能下降 | 中 | 1. 增加缓存机制<br>2. 懒加载工具列表<br>3. 性能基准测试 |
| 用户体验混乱 | 中 | 1. 清晰的模式切换 UI<br>2. 首次使用引导<br>3. 保留快捷入口 |

### 4.2 测试策略

1. **单元测试**：新的 DialogueService、ChatStore
2. **集成测试**：完整对话流程（chat/agent 模式）
3. **数据迁移测试**：各种边界数据
4. **性能测试**：流式响应延迟、内存占用
5. **用户测试**：内部试用一周后再全量发布

---

## 5. 验收标准

### 5.1 功能验收

- [ ] AI 快速对话功能正常（单轮、多轮、SSE 流式）
- [ ] Agent 工具模式正常（工具调用、多轮迭代）
- [ ] 两种模式可无缝切换
- [ ] 历史会话正确显示和加载
- [ ] 数据迁移完整无丢失

### 5.2 性能验收

- [ ] 首 Token 延迟 < 500ms（与重构前持平）
- [ ] 流式响应流畅无卡顿
- [ ] 内存占用不高于重构前

### 5.3 代码验收

- [ ] 废弃代码已清理
- [ ] 新代码覆盖率达到 80%+
- [ ] TypeScript 无类型错误
- [ ] ESLint 无警告

---

## 6. 时间计划

| 阶段 | 工期 | 负责人 | 产出 |
|-----|------|-------|------|
| Phase 1: 类型系统 | 1 天 | - | types-chat.ts |
| Phase 2: 后端重构 | 2 天 | - | dialogue-service.ts, chat-store.ts |
| Phase 3: 前端重构 | 2 天 | - | useChat.ts, Chat.tsx |
| Phase 4: 数据迁移 | 1 天 | - | 迁移脚本，测试通过 |
| Phase 5: 清理废弃 | 1 天 | - | 代码清理，回归测试 |
| **总计** | **7 天** | - | - |

---

## 7. 后续优化方向

1. **智能模式切换**：根据用户输入自动选择 chat/agent 模式
2. **会话分组**：支持按项目/话题分组管理会话
3. **全局搜索**：跨会话搜索历史消息
4. **导出功能**：支持导出为 Markdown/PDF
5. **插件系统**：允许用户自定义工具

---

**创建时间**: 2026-06-10  
**版本**: v1.0  
**状态**: 待评审
