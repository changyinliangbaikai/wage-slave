// ─────────────────────────────────────────────
// IPC Channel 名称常量
// 命名规则：方向前缀 + 模块 + 动作
//   main-to-renderer: 主进程 → 渲染进程（push 事件）
//   renderer-to-main: 渲染进程 → 主进程（invoke/send）
// ─────────────────────────────────────────────

export const IPC = {
  // ── 主进程 → 渲染进程（单向 push）──────────────
  TRIGGER_MORNING:     'main:trigger-morning',
  TRIGGER_BREAK:       'main:trigger-break',
  TRIGGER_EVENING:     'main:trigger-evening',
  TRIGGER_SUMMARY:     'main:trigger-summary',
  CAT_STATE_CHANGE:    'main:cat-state-change',

  // ── 渲染进程 → 主进程（双向 invoke）────────────

  // 配置
  CONFIG_GET:          'renderer:config-get',
  CONFIG_SET:          'renderer:config-set',
  API_KEY_GET:         'renderer:apikey-get',
  API_KEY_SET:         'renderer:apikey-set',
  API_TEST:            'renderer:api-test',

  // 数据读写
  LOG_GET:             'renderer:log-get',        // 读取某天日志
  LOG_SAVE:            'renderer:log-save',        // 保存日志
  TODOS_GET:           'renderer:todos-get',       // 读取某天待办
  TODOS_SAVE:          'renderer:todos-save',      // 保存待办
  LOGS_RANGE:          'renderer:logs-range',      // 读取时间范围内所有日志

  // LLM 调用（在主进程执行，绕过 CORS）
  LLM_PARSE_PLAN:      'renderer:llm-parse-plan',    // 解析工作计划 → TodoItem[]
  LLM_SUMMARY:         'renderer:llm-summary',       // 生成工作总结（非流式）
  LLM_SUMMARY_STREAM:  'main:llm-summary-chunk',     // 流式总结的增量推送

  // 导出
  EXPORT_SUMMARY_DOCX: 'renderer:export-summary-docx',  // 导出总结为 Word 文档
  SELECT_DIRECTORY:     'renderer:select-directory',     // 打开目录选择器

  // 小工具
  TOOLS_OPEN_FILE_DIALOG: 'renderer:tools-open-file-dialog', // 打开文件选择对话框
  TOOLS_READ_FILE:        'renderer:tools-read-file',        // 读取本地文件内容
  TOOLS_SPELL_CHECK:      'renderer:tools-spell-check',      // 错别字检查

  // 定时任务
  SCHEDULER_LIST_TASKS:   'renderer:scheduler-list-tasks',   // 获取任务列表
  SCHEDULER_SAVE_TASK:    'renderer:scheduler-save-task',     // 创建/更新任务
  SCHEDULER_DELETE_TASK:  'renderer:scheduler-delete-task',   // 删除任务
  SCHEDULER_TOGGLE_TASK:  'renderer:scheduler-toggle-task',   // 启用/禁用任务
  SCHEDULER_RUN_TASK:     'renderer:scheduler-run-task',      // 手动执行任务
  SCHEDULER_GET_LOGS:     'renderer:scheduler-get-logs',      // 获取任务执行日志
  SCHEDULER_CLEAR_LOGS:   'renderer:scheduler-clear-logs',    // 清除任务执行日志
  SCHEDULER_SELECT_DIR:   'renderer:scheduler-select-dir',    // 选择工作目录

  // 窗口行为
  WINDOW_DRAG:         'renderer:window-drag',     // 拖动窗口（发送鼠标偏移）
  WINDOW_HIDE_EDGE:    'renderer:window-hide-edge',
  WINDOW_SHOW:         'renderer:window-show',

  // 系统
  AUTO_LAUNCH_SET:     'renderer:auto-launch-set',
  SNOOZE_BREAK:        'renderer:snooze-break',    // 再等一会儿
  BREAK_DONE:          'renderer:break-done',      // 确认去休息，重置计时
  OPEN_SETTINGS:       'renderer:open-settings',
  OPEN_LOGS:           'renderer:open-logs',
  OPEN_TOOLS:          'renderer:open-tools',
} as const

export type IPCChannel = typeof IPC[keyof typeof IPC]
