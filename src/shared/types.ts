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
}

/** 像素猫动画状态 */
export type CatState =
  | 'idle'
  | 'blink'
  | 'talk'
  | 'happy'
  | 'worried'
  | 'stretch'
  | 'sleep'

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
