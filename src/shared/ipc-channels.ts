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
  TOOLS_SPELL_CHECK_CHUNK: 'main:tools-spell-check-chunk',    // 流式增量推送
  TOOLS_SPELL_CHECK_CANCEL: 'renderer:tools-spell-check-cancel', // 中止当前检查
  OPEN_LOG_FILE:          'renderer:open-log-file',          // 打开应用运行日志文件夹

  // 定时任务
  SCHEDULER_LIST_TASKS:   'renderer:scheduler-list-tasks',   // 获取任务列表
  SCHEDULER_SAVE_TASK:    'renderer:scheduler-save-task',     // 创建/更新任务
  SCHEDULER_DELETE_TASK:  'renderer:scheduler-delete-task',   // 删除任务
  SCHEDULER_TOGGLE_TASK:  'renderer:scheduler-toggle-task',   // 启用/禁用任务
  SCHEDULER_RUN_TASK:     'renderer:scheduler-run-task',      // 手动执行任务
  SCHEDULER_GET_LOGS:     'renderer:scheduler-get-logs',      // 获取任务执行日志
  SCHEDULER_CLEAR_LOGS:   'renderer:scheduler-clear-logs',    // 清除任务执行日志
  SCHEDULER_SELECT_DIR:   'renderer:scheduler-select-dir',    // 选择工作目录

  // AI 快速对话
  AI_CHAT_START:       'renderer:ai-chat-start',       // 发起一次流式对话请求
  AI_CHAT_STOP:        'renderer:ai-chat-stop',        // 中止当前流式对话
  AI_CHAT_CHUNK:       'main:ai-chat-chunk',           // 流式增量推送
  AI_CHAT_DONE:        'main:ai-chat-done',            // 流式结束（含统计）
  AI_CHAT_ERROR:       'main:ai-chat-error',           // 流式出错
  AI_CHAT_FOCUS_INPUT: 'main:ai-chat-focus-input',     // 窗口被重新唤起时聚焦输入框

  // AI 对话会话管理（历史 + 搜索）
  AI_CHAT_LIST_SESSIONS:  'renderer:ai-chat-list-sessions',   // 列出全部会话元数据
  AI_CHAT_GET_SESSION:    'renderer:ai-chat-get-session',     // 读取一条会话完整内容
  AI_CHAT_SAVE_SESSION:   'renderer:ai-chat-save-session',    // 保存/更新一条会话
  AI_CHAT_DELETE_SESSION: 'renderer:ai-chat-delete-session',  // 删除一条会话
  AI_CHAT_SEARCH:         'renderer:ai-chat-search',          // 全文搜索会话
  AI_CHAT_RENAME_SESSION: 'renderer:ai-chat-rename-session',  // 重命名会话
  AI_CHAT_PICK_ATTACHMENTS: 'renderer:ai-chat-pick-attachments', // 选择附件（多选）：打开对话框 + 读取
  AI_CHAT_READ_ATTACHMENTS: 'renderer:ai-chat-read-attachments', // 按路径读取附件（用于拖拽）

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
  OPEN_AI_CHAT:        'renderer:open-ai-chat',    // 打开 AI 快速对话窗口

  // 自动更新（基于 electron-updater）
  UPDATE_CHECK:        'renderer:update-check',    // 手动检查更新
  UPDATE_DOWNLOAD:     'renderer:update-download', // 确认下载新版本
  UPDATE_INSTALL:      'renderer:update-install',  // 下载完成后退出并安装
  UPDATE_STATUS:       'main:update-status',       // 广播更新状态（checking/available/downloading/downloaded/error）

  // 备份 / 恢复
  BACKUP_EXPORT:       'renderer:backup-export',     // 导出全量数据到 zip
  BACKUP_IMPORT:       'renderer:backup-import',     // 从 zip 恢复数据
  BACKUP_OPEN_DATA_DIR:'renderer:backup-open-dir',   // 打开 userData 目录（手动排查/备份）
  REPORT_SAVE:         'renderer:report-save',        // 把 AI 答复保存为本地 markdown 文档

  // 桌宠包（Pet Pack）管理
  PETS_LIST:            'renderer:pets-list',           // 列出所有已安装桌宠包
  PETS_GET_ACTIVE:      'renderer:pets-get-active',     // 获取当前激活包的完整 manifest（含 pet:// URL）
  PETS_ACTIVATE:        'renderer:pets-activate',       // 激活某个包
  PETS_INSTALL_SPRITE:  'pets:install-sprite',           // [兼容] 直接用本地 PNG 文件路径安装（已不在 UI 使用）
  PETS_INSTALL_SPRITE_BYTES: 'pets:install-sprite-bytes', // [当前 UI 主路径] 渲染端裁切后把 PNG 字节传上来安装
  PETS_INSTALL_ZIP:     'renderer:pets-install-zip',    // 导入 .zip 桌宠包（高级）
  PETS_REMOVE:          'renderer:pets-remove',         // 删除用户包
  PETS_OPEN_DIR:        'renderer:pets-open-dir',       // 打开用户桌宠目录
  PETS_PICK_FILE:       'renderer:pets-pick-file',      // 打开文件对话框选 PNG（返回路径 + 尺寸）
  PETS_CHANGED:         'main:pets-changed',            // 主进程→渲染：激活包变化

  // ── Agent 模式（Phase 1） ─────────────────────
  // renderer → main
  AGENT_START:          'renderer:agent-start',          // 启动一次 Agent 任务（流式）
  AGENT_STOP:           'renderer:agent-stop',           // 中止当前会话的 Agent 执行
  AGENT_STATUS:         'renderer:agent-status',         // 查询会话当前是否在执行
  AGENT_OPEN_WINDOW:    'renderer:agent-open-window',    // 打开 Agent 对话窗口
  // 会话持久化
  AGENT_LIST_SESSIONS:  'renderer:agent-list-sessions',
  AGENT_GET_SESSION:    'renderer:agent-get-session',
  AGENT_SAVE_SESSION:   'renderer:agent-save-session',
  AGENT_DELETE_SESSION: 'renderer:agent-delete-session',
  AGENT_RENAME_SESSION: 'renderer:agent-rename-session',
  // main → renderer（流式推送）
  AGENT_CHUNK:          'main:agent-chunk',              // 累计 content / reasoning 增量
  AGENT_DONE:           'main:agent-done',               // 会话执行完成
  AGENT_ERROR:          'main:agent-error',              // 执行出错
  AGENT_TOOL_START:     'main:agent-tool-start',         // 一组工具调用即将执行
  AGENT_TOOL_EXECUTING: 'main:agent-tool-executing',     // 单个工具开始执行
  AGENT_TOOL_EXECUTED:  'main:agent-tool-executed',      // 单个工具执行结束
  AGENT_NOTIFICATION:   'main:agent-notification',       // Agent 工具触发的桌面/小猫通知
} as const

export type IPCChannel = typeof IPC[keyof typeof IPC]
