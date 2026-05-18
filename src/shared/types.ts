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
  /** 当前激活的桌宠包 id，默认 'default-cat' */
  active_pet_pack: string
}

/** AI 对话附件（txt / md / docx / doc 读取后的文本 + 元数据） */
export interface AIChatAttachment {
  id: string
  fileName: string
  fileType: 'txt' | 'md' | 'docx' | 'doc'
  sizeBytes: number      // 原始文件字节数
  content: string        // 提取出来的文本（可能被截断）
  charCount: number      // 原始字符数（截断前）
  truncated: boolean     // 是否因超长被截断
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
export type ScheduleType = 'interval' | 'daily' | 'weekly'

/** 定时任务调度配置 */
export interface TaskSchedule {
  type: ScheduleType
  /** 间隔分钟（type=interval 时使用） */
  intervalMinutes?: number
  /** 执行时间 HH:mm（type=daily/weekly 时使用） */
  time?: string
  /** 星期几 0=周日 1=周一 ... 6=周六（type=weekly 时使用） */
  weekDay?: number
}

/** 定时任务 */
export interface ScheduledTask {
  id: string
  /** 任务名称 */
  name: string
  /** 执行命令 */
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
