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

  // 窗口行为
  WINDOW_DRAG:         'renderer:window-drag',     // 拖动窗口（发送鼠标偏移）
  WINDOW_HIDE_EDGE:    'renderer:window-hide-edge',
  WINDOW_SHOW:         'renderer:window-show',

  // 系统
  AUTO_LAUNCH_SET:     'renderer:auto-launch-set',
  SNOOZE_BREAK:        'renderer:snooze-break',    // 再等一会儿
  OPEN_SETTINGS:       'renderer:open-settings',
} as const

export type IPCChannel = typeof IPC[keyof typeof IPC]
