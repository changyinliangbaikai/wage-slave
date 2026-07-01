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
  SCHEDULER_STOP_TASK:    'renderer:scheduler-stop-task',     // 中止指定执行（Agent / shell）
  SCHEDULER_RUNNING:      'renderer:scheduler-running',       // 获取所有正在运行的执行 ID
  SCHEDULER_PARSE_NL:     'renderer:scheduler-parse-nl',      // 自然语言 → ScheduledTask（LLM 解析）
  SCHEDULER_GET_LOGS:     'renderer:scheduler-get-logs',      // 获取任务执行日志
  SCHEDULER_CLEAR_LOGS:   'renderer:scheduler-clear-logs',    // 清除任务执行日志
  SCHEDULER_SELECT_DIR:   'renderer:scheduler-select-dir',    // 选择工作目录
  // main → renderer
  SCHEDULER_TASK_UPDATE:  'main:scheduler-task-update',       // 任务执行状态变化，通知 UI 刷新
  SCHEDULER_TASKS_CHANGED: 'main:scheduler-tasks-changed',    // 任务列表 CRUD 变化（创建/更新/删除/启停），通知 UI 重载

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

  // ── 文件附件系统（快速对话 + Agent 模式通用）──────
  ATTACHMENT_PICK:        'renderer:attachment-pick',        // 打开文件选择器读取附件
  ATTACHMENT_READ:        'renderer:attachment-read',        // 从路径读取附件（拖拽用）

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
  AGENT_ACTIVE_CHANGED: 'main:agent-active-changed',     // Agent 全局活跃数变化（0↔>0），用于驱动小猫 busy 动画

  // ── Agent Skill 系统（Phase 2） ───────────────
  // renderer → main
  SKILL_LIST:            'renderer:skill-list',            // 列出全部 skill（含安装/启用状态）
  SKILL_GET:             'renderer:skill-get',             // 按 id 获取单个 skill
  SKILL_SEARCH:          'renderer:skill-search',          // 关键词搜索 skill
  SKILL_TOGGLE:          'renderer:skill-toggle',          // 启用/停用 skill
  SKILL_UPDATE_CONFIG:   'renderer:skill-update-config',   // 更新单个 skill 的用户配置
  SKILL_INSTALL_FILE:    'renderer:skill-install-file',    // 选本地 skill.json 安装
  SKILL_INSTALL_URL:     'renderer:skill-install-url',     // 从远程 URL 安装
  SKILL_INSTALL_MARKET:  'renderer:skill-install-market',  // 从市场一键安装
  SKILL_UNINSTALL:       'renderer:skill-uninstall',       // 卸载用户 skill（内置只停用）
  SKILL_MARKET_LIST:     'renderer:skill-market-list',     // 拉取市场 skill 列表
  SKILL_OPEN_WINDOW:     'renderer:skill-open-window',     // 打开技能管理窗口
  // main → renderer
  SKILL_CHANGED:         'main:skill-changed',             // skill 列表/状态变化，通知 UI 刷新

  // ── Agent Cron（Phase 3 独立入口，独立 JSON 存储与调度器） ─────
  // renderer → main
  AGENT_CRON_LIST:       'renderer:agent-cron-list',       // 列出 Agent Cron 任务
  AGENT_CRON_SAVE:       'renderer:agent-cron-save',       // 创建/更新 Agent Cron
  AGENT_CRON_DELETE:     'renderer:agent-cron-delete',     // 删除 Agent Cron
  AGENT_CRON_TOGGLE:     'renderer:agent-cron-toggle',     // 启用/停用 Agent Cron
  AGENT_CRON_RUN_NOW:    'renderer:agent-cron-run-now',    // 立即执行 Agent Cron
  AGENT_CRON_TEMPLATES:  'renderer:agent-cron-templates',  // 获取内置 Agent Cron 模板
  AGENT_CRON_MIGRATE:    'renderer:agent-cron-migrate',    // 迁移旧 ScheduledTask 到 Agent Cron
  AGENT_CRON_OPEN_WINDOW:'renderer:agent-cron-open-window', // 打开 Agent Cron 管理窗口

  // ── Agent 工具权限（D.1） ───────────────────────
  // renderer → main
  AGENT_GET_TOOL_GROUPS: 'renderer:agent-get-tool-groups', // 获取工具分组元数据（用于设置页渲染）

  // ── Agent 安全策略（D.3） ───────────────────────
  // renderer → main
  AGENT_GET_SECURITY_POLICY: 'renderer:agent-get-security-policy', // 获取安全策略（路径白名单 + 命令黑名单）

  // ── 统一对话系统（AI 对话 + Agent 模式合并） ─────
  // renderer → main
  CHAT_START:           'renderer:chat-start',           // 发起对话（chat / agent 模式自动分流）
  CHAT_STOP:            'renderer:chat-stop',            // 中止当前对话
  CHAT_OPEN_WINDOW:     'renderer:chat-open-window',     // 打开统一对话窗口
  CHAT_CLOSE_WINDOW:    'renderer:chat-close-window',    // 关闭统一对话窗口
  CHAT_LIST_SESSIONS:   'renderer:chat-list-sessions',   // 列出全部会话（合并 chat + agent）
  CHAT_GET_SESSION:     'renderer:chat-get-session',     // 读取一条完整会话
  CHAT_SAVE_SESSION:    'renderer:chat-save-session',    // 保存/更新一条会话
  CHAT_DELETE_SESSION:  'renderer:chat-delete-session',  // 删除一条会话
  CHAT_RENAME_SESSION:  'renderer:chat-rename-session',  // 重命名会话
  CHAT_SEARCH:          'renderer:chat-search',          // 全文搜索会话
  // main → renderer（流式推送）
  CHAT_CHUNK:           'main:chat-chunk',               // 文本/思考增量
  CHAT_TOOL_EVENT:      'main:chat-tool-event',          // 工具调用状态（Agent 模式）
  CHAT_DONE:            'main:chat-done',                // 完成（含统计）
  CHAT_ERROR:           'main:chat-error',               // 出错
  CHAT_FOCUS_INPUT:     'main:chat-focus-input',         // 窗口被重新唤起时聚焦输入框

  // ── 项目（Project）管理 ───────────────────────
  // renderer → main
  PROJECT_LIST:         'renderer:project-list',         // 列出全部项目
  PROJECT_CREATE:       'renderer:project-create',       // 新建项目（关联现有目录或新建目录）
  PROJECT_RENAME:       'renderer:project-rename',       // 重命名项目
  PROJECT_DELETE:       'renderer:project-delete',       // 删除项目（仅索引）
  PROJECT_PICK_DIR:     'renderer:project-pick-dir',     // 打开目录选择器
  PROJECT_TOGGLE_PIN:   'renderer:project-toggle-pin',   // 置顶/取消置顶项目
  PROJECT_SHOW_IN_EXPLORER: 'renderer:project-show-in-explorer', // 在系统管理器中显示项目
  // main → renderer
  PROJECT_CHANGED:      'main:project-changed',          // 项目列表变化，通知 UI 刷新

  // ── Slash 命令（状态控制型） ───────────────────
  // renderer → main
  CHAT_COMPACT_SESSION: 'renderer:chat-compact-session', // 永久压缩当前会话历史

  // ── 终端命令确认通道 ──────────────────────────
  CHAT_CONFIRM_COMMAND: 'main:chat-confirm-command',
  CHAT_CONFIRM_COMMAND_RESPONSE: 'renderer:chat-confirm-command-response',

  // ── 打开外部文件/文件夹 ──────────────────────────
  SHELL_OPEN_PATH: 'renderer:shell-open-path',
} as const

export type IPCChannel = typeof IPC[keyof typeof IPC]
