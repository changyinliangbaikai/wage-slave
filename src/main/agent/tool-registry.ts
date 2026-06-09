/**
 * Agent 工具注册表
 *
 * 输出 OpenAI function calling 格式的 schema 数组，
 * 直接传给 LLM API 的 tools 字段。
 *
 * 设计原则：
 *  1. 每个工具职责单一
 *  2. 参数设计简单，复杂逻辑放到 tool-executor 内部
 *  3. description 要写清楚"什么时候用"和"什么时候不要用"
 */

import { getConfig } from '../store'

/** 单个工具的 schema（OpenAI 兼容） */
export interface ToolSchema {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, unknown>
      required?: string[]
    }
  }
}

export const AGENT_TOOL_SCHEMAS: ToolSchema[] = [
  // ── 文件操作 ─────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取本地文件内容。默认最多读取 200 行；可用 offset + max_lines 分块继续读取，避免超大文件撑爆上下文。仅允许在路径白名单内的文件。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件的绝对路径，或 ~/ 起始的相对路径' },
          offset: { type: 'integer', description: '起始行号（从 0 开始），默认 0', minimum: 0 },
          max_lines: { type: 'integer', description: '最大读取行数；缺省 200 行，上限 1000 行', minimum: 1, maximum: 1000 },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '写入内容到文件。文件存在则覆盖，不存在则创建（自动建父目录）。仅允许写入路径白名单内的位置。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径' },
          content: { type: 'string', description: '要写入的完整内容' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: '在文件中精确替换文本片段。old_string 必须在文件中出现且默认只替换第一处，replace_all=true 则替换全部。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径' },
          old_string: { type: 'string', description: '要被替换的精确文本（含换行）' },
          new_string: { type: 'string', description: '替换后的新文本' },
          replace_all: { type: 'boolean', description: '是否替换所有匹配项，默认 false' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: '列出目录中的文件和子目录。可选 glob 模式过滤（如 *.md）。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '目录路径' },
          pattern: { type: 'string', description: 'glob 过滤模式，如 "*.ts"、"report-*.md"' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: '在指定目录中搜索包含特定文本的文件（递归）。返回命中文件路径列表。跨平台用 Node 实现，无依赖。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '搜索的根目录' },
          query: { type: 'string', description: '要搜索的文本（大小写不敏感）' },
          file_pattern: { type: 'string', description: '可选：仅搜索匹配该 glob 的文件，如 "*.ts"' },
          max_results: { type: 'integer', description: '最多返回多少个文件，默认 50', minimum: 1, maximum: 500 },
        },
        required: ['path', 'query'],
      },
    },
  },

  // ── 命令执行 ─────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: '在系统 shell 中执行命令。默认 30s 超时；命令黑名单（rm -rf / 等）会被拒绝。请优先用专用工具代替命令（如 list_files 而不是 ls）。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '完整 shell 命令字符串' },
          work_dir: { type: 'string', description: '工作目录，默认 cwd（必须在白名单内）' },
          timeout_ms: { type: 'integer', description: '超时毫秒，默认 30000，最大 120000', minimum: 1000, maximum: 120000 },
        },
        required: ['command'],
      },
    },
  },

  // ── 小牛马数据操作 ───────────────────────────
  {
    type: 'function',
    function: {
      name: 'get_today_log',
      description: '获取今日工作日志（含计划、待办、晚间复盘文本）。无日志时返回友好提示。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_todos',
      description: '获取今日全部待办事项列表（含状态、优先级、预估耗时）。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_todo',
      description: '在今日待办列表中新增一条待办。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '待办标题（限 50 字以内）' },
          priority: { type: 'string', enum: ['high', 'medium', 'low'], description: '优先级，默认 medium' },
          estimated_min: { type: 'integer', description: '预估耗时（分钟），可选', minimum: 1 },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_todo',
      description: '修改今日某条待办的状态、标题或优先级。需要先用 get_todos 查到目标 id。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '待办 id' },
          status: { type: 'string', enum: ['pending', 'done'], description: '新状态' },
          title: { type: 'string', description: '新标题' },
          priority: { type: 'string', enum: ['high', 'medium', 'low'], description: '新优先级' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'append_log',
      description: '向今日工作日志的指定字段追加文本（默认追加到 eod_log）。多次调用会累加而非覆盖。',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: '要追加的内容' },
          append_to: { type: 'string', enum: ['eod_log'], description: '追加到哪个字段，默认 eod_log' },
        },
        required: ['content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_logs_range',
      description: '获取指定日期范围内的所有工作日志（含每天的待办与复盘文本）。常用于生成周报/月报。',
      parameters: {
        type: 'object',
        properties: {
          start_date: { type: 'string', description: '开始日期 YYYY-MM-DD' },
          end_date: { type: 'string', description: '结束日期 YYYY-MM-DD（含当天）' },
        },
        required: ['start_date', 'end_date'],
      },
    },
  },

  // ── 定时任务管理（Phase 3.6：用户提到"定时""每天""每周""每隔""提醒"必用本组工具，禁止 crontab/launchctl）
  {
    type: 'function',
    function: {
      name: 'scheduler_list_tasks',
      description: '列出小牛马应用内的所有定时任务（含 shell 与 agent 两种）。在用户问"我有哪些定时任务"或要修改/删除某条任务前请先调用，拿到任务 id 列表。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'scheduler_create_task',
      description:
        '在小牛马应用内创建一条定时任务。这是处理"设置定时""每天X点提醒我""每周X""每隔N分钟"等需求的【唯一】正确方式——严禁使用 run_command 操作系统 crontab / launchctl / launchd / schtasks。' +
        ' 默认建议 kind=agent，触发时直接让小牛马 Agent 执行 user_input 中的指令；只有用户明确要求执行 shell 命令时才用 kind=shell。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '任务名称，简洁明了，限 30 字以内' },
          kind: {
            type: 'string',
            enum: ['agent', 'shell'],
            description: 'agent=触发时让小牛马 Agent 执行一段自然语言指令（推荐）；shell=运行一条系统命令',
          },
          user_input: {
            type: 'string',
            description: '【kind=agent 必填】触发时投喂给 Agent 的输入文本，比如"提醒我喝水并写句鼓励的话"',
          },
          command: { type: 'string', description: '【kind=shell 必填】完整 shell 命令字符串' },
          work_dir: { type: 'string', description: '【kind=shell 可选】工作目录' },
          schedule_type: {
            type: 'string',
            enum: ['interval', 'daily', 'weekly'],
            description: 'interval=每隔 N 分钟；daily=每天 HH:mm；weekly=每周指定一天 HH:mm',
          },
          interval_minutes: {
            type: 'integer',
            description: '【schedule_type=interval 必填】间隔分钟数 (1-1440)',
            minimum: 1,
            maximum: 1440,
          },
          time: {
            type: 'string',
            description: '【schedule_type=daily/weekly 必填】HH:mm 24小时制，如 09:00、18:30',
          },
          week_day: {
            type: 'integer',
            description: '【schedule_type=weekly 必填】星期几：0=周日 1=周一 ... 6=周六',
            minimum: 0,
            maximum: 6,
          },
          enabled: { type: 'boolean', description: '创建后是否立即启用，默认 true' },
        },
        required: ['name', 'kind', 'schedule_type'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'scheduler_update_task',
      description: '修改已有定时任务的字段。先用 scheduler_list_tasks 查到目标任务的 id。只传需要更新的字段，其余字段保持原值。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '任务 id' },
          name: { type: 'string' },
          user_input: { type: 'string', description: '仅 agent 任务有效' },
          command: { type: 'string', description: '仅 shell 任务有效' },
          work_dir: { type: 'string' },
          schedule_type: { type: 'string', enum: ['interval', 'daily', 'weekly'] },
          interval_minutes: { type: 'integer', minimum: 1, maximum: 1440 },
          time: { type: 'string' },
          week_day: { type: 'integer', minimum: 0, maximum: 6 },
          enabled: { type: 'boolean' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'scheduler_delete_task',
      description: '删除一条定时任务及其历史执行日志。删除前应当先与用户确认。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '任务 id' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'scheduler_toggle_task',
      description: '翻转一条定时任务的启用状态（启用↔禁用）。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '任务 id' },
        },
        required: ['id'],
      },
    },
  },

  // ── 系统操作 ─────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'open_file',
      description: '用系统默认程序打开文件或目录。仅允许打开白名单内路径。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件或目录路径' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'show_notification',
      description: '在桌面显示一个系统通知（也会推送给小猫气泡）。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '通知标题（限 40 字）' },
          body: { type: 'string', description: '通知内容（限 200 字）' },
        },
        required: ['title', 'body'],
      },
    },
  },

  // ── 流程控制 ─────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'wait',
      description: '暂停指定毫秒数（最大 60000）。仅在确实需要等待外部事件时使用，避免浪费用户时间。',
      parameters: {
        type: 'object',
        properties: {
          ms: { type: 'integer', description: '等待毫秒，1-60000', minimum: 1, maximum: 60000 },
        },
        required: ['ms'],
      },
    },
  },
]

/**
 * 工具分组：仅用于 UI 渲染开关，不影响 LLM 调用协议
 * 给设置页一个清晰的"按类别批量启停"视图，比一字排开 N 个 checkbox 友好
 */
export type ToolGroupId = 'file' | 'command' | 'data' | 'scheduler' | 'system' | 'control'

export interface ToolGroupMeta {
  id: ToolGroupId
  /** UI 显示标题 */
  label: string
  /** UI 显示的副标题/说明 */
  description: string
  /** 本组包含的工具名（必须与 AGENT_TOOL_SCHEMAS 中的 name 完全一致） */
  toolNames: string[]
  /** 是否高风险：UI 上会加一个⚠️标识，禁用时给一句提示 */
  dangerous?: boolean
}

export const AGENT_TOOL_GROUPS: ToolGroupMeta[] = [
  {
    id: 'file',
    label: '文件操作',
    description: '读取 / 写入 / 编辑 / 列目录 / 搜索文件（仅限白名单路径）',
    toolNames: ['read_file', 'write_file', 'edit_file', 'list_files', 'search_files'],
  },
  {
    id: 'command',
    label: '命令执行',
    description: '运行 shell 命令。受黑名单和二次确认双重保护，但仍是最高风险工具',
    toolNames: ['run_command'],
    dangerous: true,
  },
  {
    id: 'data',
    label: '小牛马数据',
    description: '读写本地日志、待办、复盘（应用内 JSON 存储，不会动到系统其他位置）',
    toolNames: ['get_today_log', 'get_todos', 'save_todo', 'update_todo', 'append_log', 'get_logs_range'],
  },
  {
    id: 'scheduler',
    label: '定时任务',
    description: '查看/新建/修改/删除/启停应用内定时任务（关闭后 Agent 不能在对话里改任务）',
    toolNames: [
      'scheduler_list_tasks',
      'scheduler_create_task',
      'scheduler_update_task',
      'scheduler_delete_task',
      'scheduler_toggle_task',
    ],
  },
  {
    id: 'system',
    label: '系统操作',
    description: '用系统默认程序打开文件 / 弹出桌面通知',
    toolNames: ['open_file', 'show_notification'],
  },
  {
    id: 'control',
    label: '流程控制',
    description: '让 Agent 主动等待若干秒（一般无需关闭）',
    toolNames: ['wait'],
  },
]

/** 判断一个工具是否在禁用列表中 */
function isToolDisabled(toolName: string, disabledList: string[] | undefined): boolean {
  return !!disabledList && disabledList.includes(toolName)
}

/**
 * 获取当前激活的工具列表
 *
 * 数据流：config.agent_disabled_tools → 从 AGENT_TOOL_SCHEMAS 过滤掉
 * - 在每轮 LLM 调用前都会读一次 config，所以用户在设置页关掉某个工具，
 *   下一轮 LLM 调用就看不到了，无需重启
 * - 由于 config 读取是同步的（基于本地 JSON），不会对 Agent 性能产生影响
 */
export function getActiveToolSchemas(): ToolSchema[] {
  const disabled = getConfig().agent_disabled_tools ?? []
  if (disabled.length === 0) return AGENT_TOOL_SCHEMAS
  const filtered = AGENT_TOOL_SCHEMAS.filter(t => !isToolDisabled(t.function.name, disabled))
  // 调试日志：让用户能在主日志里看到哪些工具被禁用
  if (filtered.length !== AGENT_TOOL_SCHEMAS.length) {
    console.log(`[ToolRegistry] 工具开关：禁用 ${disabled.length} 个，启用 ${filtered.length} 个`)
  }
  return filtered
}

/**
 * 判断某个工具名是否被用户禁用（tool-executor 在 dispatch 前会调用，作为二次保险）
 * 即便 LLM 用了过时的 schema 也无法绕过
 */
export function isToolEnabled(toolName: string): boolean {
  const disabled = getConfig().agent_disabled_tools ?? []
  return !isToolDisabled(toolName, disabled)
}

/** 通过工具名查描述（UI 标签 + 日志用） */
export function getToolDescription(name: string): string {
  return AGENT_TOOL_SCHEMAS.find(t => t.function.name === name)?.function.description ?? name
}

/** 全部工具名集合（运行时校验 LLM 返回的工具名是否合法） */
export function getKnownToolNames(): Set<string> {
  return new Set(AGENT_TOOL_SCHEMAS.map(t => t.function.name))
}
