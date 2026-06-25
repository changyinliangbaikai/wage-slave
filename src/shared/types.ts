// ─────────────────────────────────────────────
// 共享类型定义（主进程 & 渲染进程通用）
// ─────────────────────────────────────────────

/** 待办项 */
export interface TodoItem {
  id: string
  title: string
  priority: 'high' | 'medium' | 'low'
  estimated_min: number | null
  status: 'pending' | 'done'
}

/** 每日工作日志 */
export interface DailyLog {
  date: string              // YYYY-MM-DD
  plan_input: string        // 用户原始输入
  todos: TodoItem[]
  morning_skipped: boolean  // 是否跳过了晨间计划录入
  eod_log: string           // 晚间复盘日志（自由文本）
  created_at: string        // ISO 时间字符串
  updated_at: string
}

/** 用户配置 */
export interface AppConfig {
  work_start: string        // HH:mm，如 "09:00"
  work_end: string          // HH:mm，如 "18:00"
  focus_threshold_min: number   // 连续工作提醒阈值（分钟），默认 30
  away_threshold_min: number    // 离开重置阈值（分钟），默认 5
  snooze_min: number            // 再等一会儿延迟（分钟），默认 10
  llm_api_url: string
  llm_model: string
  auto_launch: boolean          // 开机自启
  cat_position: { x: number; y: number }
  cat_hidden: boolean           // 是否收起到边缘
  summary_export_docx: boolean  // 是否导出工作总结为 Word 文档
  summary_export_dir: string    // 导出目录路径
  ai_chat_hotkey: string        // 唤出 AI 对话窗口的全局快捷键（Electron Accelerator 格式）
  ai_chat_system_prompt: string // AI 对话的系统提示词（可选，作为「通用」角色的底稿）
  /** AI 对话窗口上次的边界（记忆尺寸/位置） */
  ai_chat_window_bounds?: { x: number; y: number; width: number; height: number }
  /** 统一对话窗口上次的边界（记忆尺寸/位置） */
  chat_window_bounds?: { x: number; y: number; width: number; height: number }
  /** 当前激活的桌宠包 id，默认 'default-cat' */
  active_pet_pack: string
  /**
   * Agent 工具黑名单：被列出的工具名将从 tool-registry 中过滤掉，LLM 看不到
   * 也无法调用。默认空数组（启用全部工具）。
   */
  agent_disabled_tools?: string[]
  /**
   * Agent 专用 LLM API URL（可选）。如果不填，回退到主聊天的 llm_api_url
   */
  agent_llm_api_url?: string
  /**
   * Agent 专用模型名称（可选）。如果不填，回退到主聊天的 llm_model
   */
  agent_llm_model?: string
  /**
   * Agent 单次任务最大迭代步数，防止工具循环；默认 20
   */
  agent_max_iterations?: number
  /**
   * Agent 路径白名单扩展：默认白名单之外，用户额外允许 Agent 访问的目录。
   */
  agent_allowed_paths_extra?: string[]
  /**
   * Agent LLM 推理强度（reasoning_effort）：仅对支持推理参数的模型生效（如 o1 / o3 / gpt-5 等）
   * 取值：'low' / 'medium' / 'high'；空字符串或缺省表示不发送该参数
   */
  agent_reasoning_effort?: 'low' | 'medium' | 'high' | ''
}

/** Agent 工具分组元数据（仅用于设置页 UI 渲染） */
export interface AgentToolGroupMeta {
  id: string
  label: string
  description: string
  toolNames: string[]
  dangerous?: boolean
}

/** Agent 安全策略（用于设置页展示） */
export interface AgentSecurityPolicy {
  /** 当前生效路径白名单（绝对路径前缀，默认 + 用户扩展） */
  allowedPaths: string[]
  /** 应用内置默认路径白名单 */
  defaultAllowedPaths?: string[]
  /** 用户额外配置的路径白名单 */
  customAllowedPaths?: string[]
  /** 命令黑名单规则（正则描述 + 原因） */
  commandBlacklist: { pattern: string; reason: string }[]
}

/** AI 对话附件（txt / md / docx / doc 等读取后的文本 + 元数据） */
export interface AIChatAttachment {
  id: string
  path?: string          // 真实文件路径
  fileName: string
  fileType: string       // 'txt' | 'md' | 'docx' | 'pdf' | 'js' | 'py' 等
  mimeType: string       // MIME 类型
  sizeBytes: number      // 原始文件字节数
  content: string        // 提取出来的文本（可能被截断）
  charCount: number      // 原始字符数（截断前）
  truncated: boolean     // 是否因超长被截断
  truncatedAt?: number   // 截断位置
  status: 'pending' | 'reading' | 'success' | 'error'
  error?: string         // 读取错误信息
  createdAt: number      // 添加时间戳
}

/** 附件读取结果 */
export interface AttachmentReadResult {
  ok: boolean
  attachments: AIChatAttachment[]
  errors: Array<{ fileName: string; error: string; code: string }>
  warnings: Array<{ fileName: string; warning: string; code: string }>
}

/** AI 对话预置角色模板（邮件助手 / 翻译助手 等） */
export interface AIChatPersona {
  id: string
  name: string
  icon: string
  /** 系统提示词；为空字符串则继承全局 ai_chat_system_prompt */
  systemPrompt: string
  /** 可选：覆盖 temperature；未设置时使用服务默认 */
  temperature?: number
}

// ─────────────────────────────────────────────
// AI 快速对话模块类型
// ─────────────────────────────────────────────

/** 聊天消息角色 */
export type AIChatRole = 'system' | 'user' | 'assistant'

/** 聊天消息（持久化 / IPC 使用） */
export interface AIChatMessage {
  /** 消息 id，渲染层用 */
  id: string
  role: AIChatRole
  /** 正式回复内容（不含 think 块） */
  content: string
  /** 推理内容（<think>...</think> 或 reasoning_content） */
  reasoning?: string
  /** 本条消息的 token 统计（仅 assistant 消息有） */
  stats?: AIChatStats
  /** 附件列表（仅 user 消息有；原文内容会在发送时拼接进 prompt） */
  attachments?: AIChatAttachment[]
  /** 创建时间（毫秒） */
  createdAt: number
}

/** Token 统计 */
export interface AIChatStats {
  /** 输入 token 数（prompt_tokens，若 API 未返回则为估算值） */
  promptTokens: number
  /** 输出 token 数（completion_tokens） */
  completionTokens: number
  /** 每秒 token 生成速度 */
  tokensPerSecond: number
  /** 首 token 延迟（毫秒） */
  firstTokenLatency: number
  /** 总耗时（毫秒） */
  totalDurationMs: number
  /** 是否来自 API usage 字段（true=精确，false=本地估算） */
  fromApiUsage: boolean
}

/** 流式增量推送的载荷（main -> renderer） */
export interface AIChatChunkPayload {
  requestId: string
  /** 正式回复累计内容 */
  content: string
  /** 推理累计内容 */
  reasoning: string
}

/** 流式结束载荷 */
export interface AIChatDonePayload {
  requestId: string
  content: string
  reasoning: string
  stats: AIChatStats
}

/** 流式错误载荷 */
export interface AIChatErrorPayload {
  requestId: string
  error: string
}

/** 发起对话请求的参数 */
export interface AIChatRequest {
  requestId: string
  /** 完整的消息历史（不含本轮 assistant） */
  messages: Array<Pick<AIChatMessage, 'role' | 'content'>>
}

/** 会话元数据（侧边栏列表使用，不含完整消息） */
export interface AIChatSessionMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messageCount: number
  /** 首条用户消息的前若干字，用于列表预览 */
  preview: string
}

/** 完整会话（元数据 + 消息列表） */
export interface AIChatSession extends AIChatSessionMeta {
  messages: AIChatMessage[]
  /** 本会话使用的预置角色 id；缺失则默认 'general' */
  personaId?: string
}

/** 搜索命中结果 */
export interface AIChatSearchHit {
  sessionId: string
  title: string
  updatedAt: number
  /** 命中的上下文片段（首个匹配位置周围） */
  snippet: string
  /** 匹配次数（标题 + 所有消息累计） */
  matchCount: number
  /** 命中的消息 id 列表（便于跳转定位） */
  matchedMessageIds: string[]
}

/**
 * 桌宠动画核心状态（4 态精简模型）
 *
 * 用途映射：
 *   - idle:      默认循环（空闲）
 *   - petting:   点击/抚摸/喂食/勾选待办等轻量交互（循环，约 2 秒后回 idle）
 *   - celebrate: 计划录入完成/晚间高完成率/庆祝（一次性，播完自动回 idle）
 *   - busy:      LLM 调用/流式生成/正在录入流程（循环）
 *
 * 桌宠包加载时仅 `idle` 必填；其余缺失时引擎自动回退到 `fallback`（默认 idle）。
 */
export type CatState = 'idle' | 'petting' | 'celebrate' | 'busy'

/** 桌宠包核心状态常量数组（供运行时校验/遍历） */
export const PET_CORE_STATES: readonly CatState[] = ['idle', 'petting', 'celebrate', 'busy'] as const

// ─────────────────────────────────────────────
// 桌宠包（Pet Pack）规范类型
// ─────────────────────────────────────────────

/** 单个动画切片：从 sprite sheet 切出一段连续帧 */
export interface PetSpriteAnimation {
  type: 'sprite'
  /** 相对包根目录的 sprite 图片路径 */
  source: string
  /** 起始帧索引（从 0 开始） */
  startFrame: number
  /** 帧数 */
  frameCount: number
  /** 帧率 */
  fps: number
  /** 是否循环（false = 一次性，播完回 idle） */
  loop: boolean
  /** 排布方式：横向（默认）/竖向 */
  layout?: 'horizontal' | 'vertical'
}

/** 单个动画切片：使用独立帧序列（高级模式） */
export interface PetFramesAnimation {
  type: 'frames'
  /** 相对包根目录的帧图片路径数组 */
  frames: string[]
  fps: number
  loop: boolean
}

export type PetAnimationSpec = PetSpriteAnimation | PetFramesAnimation

/** 桌宠包 manifest（v1 schema） */
export interface PetManifest {
  /** 固定为 'xiaoniu-pet/v1' */
  schema: 'xiaoniu-pet/v1'
  /** 包唯一标识，匹配 ^[a-z0-9_-]{1,64}$ */
  id: string
  name: string
  version: string
  author?: string
  description?: string
  /** 缩略图相对路径 */
  thumbnail?: string
  /** 单帧像素尺寸与渲染缩放 */
  frame: {
    width: number
    height: number
    /** 显示缩放，默认 0.75 */
    displayScale?: number
  }
  /** 缺失动画时的回退状态，默认 'idle' */
  fallback?: CatState
  /** 4 个核心动画：仅 idle 必填 */
  animations: Partial<Record<CatState, PetAnimationSpec>> & { idle: PetAnimationSpec }
  /** 行为参数（可选） */
  behavior?: {
    /** （保留扩展） */
    [key: string]: unknown
  }
}

/** 桌宠包来源：builtin = 内置；user = 用户自行安装 */
export type PetPackScope = 'builtin' | 'user'

/** 列表项元数据（不含 animations 完整结构，供 UI 列表使用） */
export interface PetPackMeta {
  id: string
  name: string
  version: string
  author?: string
  description?: string
  scope: PetPackScope
  /** 已 normalize 为 pet:// 的缩略图 URL；缺失时为 null */
  thumbnailUrl: string | null
  /** 是否当前激活 */
  active: boolean
}

/** 完整激活包数据（含资源 URL，渲染进程直接使用） */
export interface ActivePetPack {
  meta: PetPackMeta
  /** 把 manifest 中所有相对路径替换为 pet:// 协议 URL 后的 manifest */
  manifest: PetManifest
  /** sprite/frames 的根 URL，用于动态拼接（pet://<scope>/<id>/） */
  baseUrl: string
}

/** 气泡类型 */
export type BubbleType =
  | 'morning-greeting'    // 晨间问候 + 输入框
  | 'break-reminder'      // 休息提醒
  | 'evening-review'      // 晚间复盘
  | 'summary-prompt'      // 月末总结提示
  | 'message'             // 纯文字通知

/** IPC 从主进程推送到渲染进程的事件载荷 */
export interface TriggerMorningPayload {
  date: string
}

export interface TriggerBreakPayload {
  elapsed_min: number  // 已连续工作多少分钟
}

export interface TriggerEveningPayload {
  date: string
  has_todos: boolean
}

/** LLM 配置（不含 Key，Key 单独存 keytar） */
export interface LLMConfig {
  api_url: string
  model: string
}

// ─────────────────────────────────────────────
// 小工具模块类型
// ─────────────────────────────────────────────

/** 错别字检查结果项 */
export interface SpellCheckError {
  /** 错误文字在原文中的起始位置 */
  start: number
  /** 错误文字在原文中的结束位置 */
  end: number
  /** 原文（错误部分） */
  original: string
  /** 建议修正 */
  correction: string
  /** 修正理由 */
  reason?: string
}

/** 错别字检查返回结果 */
export interface SpellCheckResult {
  /** 原文 */
  originalText: string
  /** 错误列表（无错别字时为空数组） */
  errors: SpellCheckError[]
  /** 修正后的文本 */
  correctedText: string
}

/** 文件读取结果 */
export interface FileReadResult {
  /** 文件名 */
  fileName: string
  /** 文件内容 */
  content: string
  /** 文件类型 */
  fileType: 'txt' | 'md' | 'docx' | 'doc'
}

// ─────────────────────────────────────────────
// 定时任务模块类型
// ─────────────────────────────────────────────

/** 定时任务调度类型 */
export type ScheduleType = 'interval' | 'daily' | 'weekly' | 'once' | 'delay'

/** 定时任务调度配置 */
export interface TaskSchedule {
  type: ScheduleType
  /** 间隔分钟（type=interval 时使用） */
  intervalMinutes?: number
  /** 执行时间 HH:mm（type=daily/weekly 时使用） */
  time?: string
  /** 星期几 0=周日 1=周一 ... 6=周六（type=weekly 时使用） */
  weekDay?: number
  /** 指定日期时间 ISO8601（type=once 时使用） */
  executeAt?: string
  /** 延迟秒数（type=delay 时使用） */
  delaySeconds?: number
}

/** 任务执行体类型（Phase 3：扩展为 shell 或 agent） */
export type TaskKind = 'shell' | 'agent'

/** Agent 任务参数（kind=agent 时使用） */
export interface AgentTaskSpec {
  /** 触发时投喂给 Agent 的"用户输入" */
  userInput: string
}

/** 定时任务 */
export interface ScheduledTask {
  id: string
  /** 任务名称 */
  name: string
  /**
   * 执行命令（shell 模式必填；agent 模式留空字符串）
   * 保留为必填以兼容旧 tasks.json
   */
  command: string
  /** 工作目录 */
  workDir: string
  /** 调度配置 */
  schedule: TaskSchedule
  /** 是否启用 */
  enabled: boolean
  /** 创建时间 */
  createdAt: string
  /** 更新时间 */
  updatedAt: string
  /** 最近执行时间 */
  lastRunAt?: string
  /** 最近执行状态 */
  lastRunStatus?: 'success' | 'failed' | 'running'
  /** 任务执行体（默认 shell，向后兼容） */
  kind?: TaskKind
  /** Agent 任务参数（仅 kind=agent 时存在） */
  agentTask?: AgentTaskSpec
  /** Agent Cron 视图元数据（kind=agent 时可选；用于独立 Agent Cron 管理页） */
  agentCron?: {
    description?: string
    context?: string
    allowedTools?: string[]
    maxSteps?: number
    timeoutMinutes?: number
    notify?: AgentCronNotifyConfig
  }
}

// ─────────────────────────────────────────────
// Agent Cron 模块类型
// ─────────────────────────────────────────────

/** Agent Cron 通知策略 */
export interface AgentCronNotifyConfig {
  onStart: boolean
  onComplete: boolean
  onError: boolean
}

/** Agent Cron 执行体 */
export interface AgentCronTaskSpec {
  /** 触发时投喂给 Agent 的目标文本 */
  goal: string
  /** 可选上下文，执行时拼接到 goal 后 */
  context?: string
  /** 可选工具白名单，当前作为元数据保存，后续可用于工具过滤 */
  allowedTools?: string[]
  /** 单次最大步骤数 */
  maxSteps: number
  /** 单次超时分钟数，当前作为元数据保存 */
  timeoutMinutes: number
}

/** Agent Cron 任务视图模型；底层由 agent/cron/scheduler.ts 独立 JSON 持久化与执行 */
export interface AgentCronTask {
  id: string
  name: string
  description: string
  schedule: TaskSchedule
  agentTask: AgentCronTaskSpec
  notify: AgentCronNotifyConfig
  enabled: boolean
  createdAt: string
  updatedAt: string
  lastRunAt?: string
  lastRunStatus?: 'success' | 'failed' | 'running'
}

/** Agent Cron 模板 */
export interface AgentCronTemplate {
  id: string
  icon: string
  name: string
  description: string
  template: Omit<AgentCronTask, 'id' | 'createdAt' | 'updatedAt' | 'lastRunAt' | 'lastRunStatus'>
}

/** 任务执行记录 */
export interface TaskExecution {
  id: string
  taskId: string
  taskName: string
  startTime: string
  endTime?: string
  /** 进程退出码 */
  exitCode: number | null
  /** 合并的 stdout + stderr 输出 */
  output: string
  /** 执行状态 */
  status: 'running' | 'success' | 'failed'
}

// ─────────────────────────────────────────────
// Agent 模块类型
// ─────────────────────────────────────────────

/** Agent 单条消息（持久化 + IPC 共用） */
export interface AgentMessage {
  /** 消息 id（渲染端去重用） */
  id: string
  role: 'system' | 'user' | 'assistant' | 'tool'
  /** 文本内容（assistant 决定是否显示，tool 是工具返回值） */
  content: string
  /** 推理过程（仅 assistant 有，可选） */
  reasoning?: string
  /** assistant 在本轮发起的工具调用列表（OpenAI 兼容） */
  tool_calls?: Array<{
    id: string
    name: string
    /** JSON 字符串形式参数 */
    arguments: string
  }>
  /** tool 角色专用：对应哪一次工具调用 */
  tool_call_id?: string
  /** tool 角色专用：工具名称（便于 UI 渲染） */
  tool_name?: string
  /** 附件列表（仅 user 消息有；原文内容会在发送时拼接进 prompt） */
  attachments?: AIChatAttachment[]
  /** 附加元数据（迭代轮次 / token 用量等） */
  metadata?: {
    model?: string
    iteration?: number
    promptTokens?: number
    completionTokens?: number
    totalTokens?: number
    maxTokens?: number
  }
  /** 创建时间（毫秒） */
  createdAt: number
}

/** 单次工具调用（已解析 arguments） */
export interface AgentToolCall {
  id: string
  name: string
  /** 已解析后的参数对象 */
  arguments: Record<string, unknown>
}

/** 工具执行结果 */
export interface AgentToolResult {
  toolCallId: string
  toolName: string
  /** 成功输出（字符串，方便回灌给 LLM） */
  output: string
  /** 失败时的错误信息 */
  error?: string
  /** 是否不可恢复（true 时 Orchestrator 提前中止） */
  fatal?: boolean
  /** 执行耗时（毫秒） */
  durationMs: number
}

/** Agent 会话元数据（不含完整消息，列表用） */
export interface AgentSessionMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messageCount: number
  /** 首条用户输入预览 */
  preview: string
  /** 归属项目 id；缺省为 'default'（多项目支持） */
  projectId?: string
}

/** Agent 完整会话 */
export interface AgentSession extends AgentSessionMeta {
  messages: AgentMessage[]
  /** 累计统计 */
  stats: {
    iterations: number
    toolCalls: number
    totalDurationMs: number
  }
}

/** Agent 上下文（注入到 System Prompt） */
export interface AgentContext {
  /** 当前工作目录 */
  cwd: string
  /** 用户主目录 */
  homePath: string
  /** 桌面路径 */
  desktopPath: string
  /** 文档路径 */
  documentsPath: string
  /** 下载路径 */
  downloadsPath: string
  /** 应用数据目录（小牛马 userData） */
  appDataPath: string
  /** 当前时间字符串（zh-CN 本地化） */
  currentTime: string
  /** 当前是星期几（中文） */
  dayOfWeek: string
  /** 当前操作系统 */
  platform: NodeJS.Platform
  /** 当前待办数量（今天） */
  todoCount: number
  /** 今日是否已经写日志 */
  hasTodayLog: boolean
}

// ─── Agent IPC 推送载荷 ───────────────────────

export interface AgentChunkPayload {
  sessionId: string
  /** 累计正式回复内容（不含 think） */
  content: string
  /** 累计推理内容 */
  reasoning: string
  /** 当前是第几轮迭代 */
  iteration: number
}

export interface AgentDonePayload {
  sessionId: string
  content: string
  iterations: number
  /** 累计统计 */
  stats: {
    iterations: number
    toolCalls: number
    totalDurationMs: number
  }
  /** 最终一轮的 Token 使用情况（用于前端显示上下文占比） */
  tokenUsage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
    maxTokens: number
    iteration?: number
  }
  /** 本次结束是否由用户主动中断或超时触发（true 时上游应视为 failed） */
  aborted?: boolean
  abortReason?: 'user' | 'timeout'
}

export interface AgentErrorPayload {
  sessionId: string
  error: string
  /** true 表示无法恢复，前端应停止流 */
  fatal: boolean
}

export interface AgentToolStartPayload {
  sessionId: string
  /** 本轮要执行的工具调用列表 */
  toolCalls: Array<{
    id: string
    name: string
    /** 简短描述（便于 UI 标签） */
    description: string
    /** 工具安全级别（UI 显示只读/写入/敏感提示） */
    safetyLevel: 'safe' | 'cautious' | 'sensitive'
    /** 已解析的参数（前端展示） */
    arguments: Record<string, unknown>
  }>
  /** 当前迭代轮次 */
  iteration: number
  /** 本轮 LLM 调用的 Token 使用情况（用于前端实时显示上下文占比） */
  tokenUsage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
    maxTokens: number
    iteration?: number
  }
}

export interface AgentToolExecutingPayload {
  sessionId: string
  toolId: string
  toolName: string
}

export interface AgentToolExecutedPayload {
  sessionId: string
  toolId: string
  toolName: string
  success: boolean
  output: string
  error?: string
  durationMs: number
}

/** 主进程对外推送的"小猫通知"（Agent 工具 show_notification 用） */
export interface AgentNotificationPayload {
  title: string
  body?: string
  /** 通知来源类型 */
  type?: 'tool' | 'cron-result' | 'general'
}

// ─────────────────────────────────────────────
// Agent Skill 系统类型（Phase 2）
// ─────────────────────────────────────────────

/** Skill 来源：内置 / 用户安装 / 远程市场 */
export type SkillScope = 'builtin' | 'user' | 'remote'

/** Skill 分类 */
export type SkillCategory =
  | 'productivity' // 生产力：计划、复盘、总结
  | 'file' // 文件：整理、搜索、转换
  | 'code' // 代码：审查、生成、重构
  | 'writing' // 写作：润色、翻译、摘要
  | 'automation' // 自动化：定时、批处理
  | 'custom' // 自定义

/** Skill 用户配置。保持 JSON 结构，具体语义由 Skill Prompt 解释 */
export type SkillConfig = Record<string, unknown>

/**
 * Agent 技能（预定义工作流模板）
 * 类比：工具是"锤子"，Skill 是"装修方案"
 * 命中 triggers 后把 systemPromptAddition 注入到 System Prompt
 */
export interface AgentSkill {
  /** 唯一 id（kebab-case） */
  id: string
  /** 显示名称 */
  name: string
  /** 一句话描述 */
  description: string
  /** 分类 */
  category: SkillCategory
  /** emoji 图标 */
  icon: string
  /** 作者 */
  author: string
  /** 版本号（semver） */
  version: string
  /** 触发关键词：用户输入命中任一即激活该技能 */
  triggers: string[]
  /** 激活后注入 System Prompt 的技能说明（含执行步骤） */
  systemPromptAddition: string
  /** 推荐使用的工具名（仅提示，不强制限制） */
  recommendedTools?: string[]
  /** 来源 */
  scope: SkillScope
  /** 元信息 */
  meta?: {
    tags?: string[]
    createdAt?: string
    updatedAt?: string
  }
}

/** Skill 安装/启停记录（持久化在 installs.json） */
export interface SkillInstallRecord {
  skillId: string
  /** 安装时间（ISO） */
  installedAt: string
  /** 来源 */
  source: SkillScope
  /** 是否启用（停用后不参与匹配注入） */
  enabled: boolean
  /** 用户为该 Skill 保存的配置（可选） */
  config?: SkillConfig
}

/** 带安装/启用状态的 Skill（列表展示用） */
export interface SkillWithState extends AgentSkill {
  /** 是否已安装（内置恒为 true） */
  installed: boolean
  /** 是否启用 */
  enabled: boolean
  /** 用户为该 Skill 保存的配置 */
  config?: SkillConfig
}

/** 市场中的 Skill 条目（含安装统计等发现信息） */
export interface MarketSkillItem extends AgentSkill {
  /** 远程下载地址（skill.json） */
  downloadUrl?: string
  /** 安装次数（展示用） */
  installs?: number
  /** 评分 0-5 */
  rating?: number
}
