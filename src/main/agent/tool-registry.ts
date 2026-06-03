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
      description: '读取本地文件内容。支持指定起始行和最大行数，避免读取超大文件。仅允许在路径白名单内的文件。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件的绝对路径，或 ~/ 起始的相对路径' },
          offset: { type: 'integer', description: '起始行号（从 0 开始），默认 0', minimum: 0 },
          max_lines: { type: 'integer', description: '最大读取行数；缺省读取全部，建议 200 行以内', minimum: 1 },
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
 * 获取当前激活的工具列表（Phase 2 会接入用户配置的工具开关）
 */
export function getActiveToolSchemas(): ToolSchema[] {
  return AGENT_TOOL_SCHEMAS
}

/** 通过工具名查描述（UI 标签 + 日志用） */
export function getToolDescription(name: string): string {
  return AGENT_TOOL_SCHEMAS.find(t => t.function.name === name)?.function.description ?? name
}

/** 全部工具名集合（运行时校验 LLM 返回的工具名是否合法） */
export function getKnownToolNames(): Set<string> {
  return new Set(AGENT_TOOL_SCHEMAS.map(t => t.function.name))
}
