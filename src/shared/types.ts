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
