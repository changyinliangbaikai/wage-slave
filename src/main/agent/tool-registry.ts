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
      description: '读取本地文件内容。支持纯文本文件以及 .docx、.doc、.pdf、.xlsx、.xls 等办公文档（会自动解析提取文本内容）。读取 Word/PDF/Excel 等二进制文档时请直接使用本工具，无需通过 run_command。默认最多读取 200 行；可用 offset + max_lines 分块继续读取，避免超大文件撑爆上下文。仅允许在路径白名单内的文件。',
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
      description:
        '在文件中精确替换文本片段。\n' +
        '【关键约束】：在编辑前必须先 read_file 读过该文件，否则容易因 old_string 不完整导致替换失败。\n' +
        '【唯一性】：old_string 在文件中必须只出现 1 次；若有多处需要替换，设置 replace_all=true。\n' +
        '【容错】：精确匹配失败时，工具会尝试忽略行尾空白与缩进差异做模糊匹配，并在结果中提示。\n' +
        '【最佳实践】：old_string 包含足够上下文（建议 2-3 行）以保证唯一性；只替换需要变动的部分，不要把整段函数 copy-paste。',
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
      description:
        '列出目录中的文件和子目录，支持按 glob 过滤、按深度递归展开。\n' +
        '【何时使用】：快速了解目录结构、查看子目录列表。\n' +
        '【禁止使用 run_command 调用 ls】：本工具已封装跨平台递归遍历与噪音目录排除。\n' +
        '常见参数：depth=2 可一次性看清两层目录结构；show_size=true 显示文件大小。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '目录路径' },
          pattern: { type: 'string', description: 'glob 过滤模式，如 "*.ts"、"report-*.md"。仅对叶子节点（文件名）生效。' },
          depth: { type: 'integer', description: '递归深度（1=仅当前层；2=展开两层；最大 5）', minimum: 1, maximum: 5 },
          show_size: { type: 'boolean', description: '是否显示文件大小，默认 false' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: '在指定目录中搜索包含特定文本的文件（递归）。返回命中文件路径列表。【若需要正则、显示行号或上下文，请优先使用 grep_code】',
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

  // ── 代码搜索（编程能力强化） ─────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'grep_code',
      description:
        '在代码中搜索文本（支持完整正则）。底层优先使用 ripgrep，未安装时回退 Node 实现。\n' +
        '【何时使用】：需要按内容查找代码（如查找函数定义、调用点、TODO 注释、错误信息等）。\n' +
        '【禁止使用 run_command 调用 grep/rg/findstr】：本工具已对正则、大小写、上下文、文件过滤做了完善封装，并自动排除 node_modules/.git 等噪音目录。\n' +
        '【常见用法】：1) 找函数定义：pattern="function\\s+myFunc"  2) 找引用：pattern="myVar"  3) 找类型：pattern="interface\\s+MyType"  4) 多行模式无此工具，请用 read_file 直接读取定位\n' +
        '输出格式：每行 "文件:行号:内容"。',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: '正则表达式搜索模式。注意 ripgrep 语法：字面量大括号要转义 "interface\\\\{\\\\}"。',
          },
          path: {
            type: 'string',
            description: '搜索路径（文件或目录），默认为当前工作目录。必须在白名单内。',
          },
          include: {
            type: 'string',
            description: 'glob 文件过滤，如 "*.ts"、"*.{js,jsx}"、"src/**/*.tsx"。',
          },
          context_lines: {
            type: 'integer',
            description: '匹配行前后各显示 N 行上下文，默认 0，范围 0-10。仅 output_mode=content 时生效。',
            minimum: 0,
            maximum: 10,
          },
          case_insensitive: {
            type: 'boolean',
            description: '是否大小写不敏感，默认 false。',
          },
          max_results: {
            type: 'integer',
            description: '最大匹配数（行数或文件数），默认 50，最大 500。',
            minimum: 1,
            maximum: 500,
          },
          output_mode: {
            type: 'string',
            enum: ['content', 'files_with_matches', 'count'],
            description: 'content=显示匹配行（默认）；files_with_matches=仅显示文件路径；count=显示每个文件的匹配数。',
          },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'glob_files',
      description:
        '按 glob 模式查找文件，支持 ** 递归、{a,b} 大括号等完整语法。\n' +
        '【何时使用】：按文件名/路径模式查找文件（如查找所有测试文件、所有配置文件等）。\n' +
        '【禁止使用 run_command 调用 find/ls -R】：本工具已封装超时保护、噪音目录排除、结果截断。\n' +
        '【常见用法】：1) 所有测试文件：pattern="**/*.test.{ts,tsx}"  2) 配置文件：pattern="**/{package,tsconfig}.json"  3) 某目录下的所有 ts：pattern="src/**/*.ts"\n' +
        '【说明】：默认不匹配以 . 开头的隐藏文件；自动排除 node_modules/.git/dist 等噪音目录。',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'glob 模式，如 "**/*.test.ts"、"src/**/index.{js,ts}"。',
          },
          path: {
            type: 'string',
            description: '搜索根目录，默认为当前工作目录。必须在白名单内。',
          },
          max_results: {
            type: 'integer',
            description: '最大返回文件数，默认 100，最大 500。',
            minimum: 1,
            maximum: 500,
          },
        },
        required: ['pattern'],
      },
    },
  },

  // ── Git 只读工具（无需二次确认） ─────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'git_status',
      description:
        '查看 Git 工作区状态（git status --short --branch 的封装）。\n' +
        '【何时使用】：需要了解当前工作区有哪些未提交的修改、当前所在分支。\n' +
        '【禁止使用 run_command 执行 git status】：本工具是只读操作，无需二次确认，体验更顺畅。',
      parameters: {
        type: 'object',
        properties: {
          work_dir: { type: 'string', description: '工作目录，默认 cwd（必须在白名单内）' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_diff',
      description:
        '查看 Git 差异（git diff 的封装）。\n' +
        '【何时使用】：需要查看具体的代码改动内容（未暂存、已暂存或对比某个 ref）。\n' +
        '【禁止使用 run_command 执行 git diff】：本工具是只读操作。',
      parameters: {
        type: 'object',
        properties: {
          work_dir: { type: 'string', description: '工作目录，默认 cwd' },
          paths: {
            type: 'array',
            description: '指定路径过滤；默认全部文件',
            items: { type: 'string' },
          },
          cached: { type: 'boolean', description: '是否查看已暂存的修改（git diff --cached），默认 false' },
          name_only: { type: 'boolean', description: '仅显示文件名列表，默认 false' },
          ref: { type: 'string', description: '与某个提交/分支比较，如 HEAD~1、main' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_log',
      description:
        '查看 Git 提交历史（git log 的封装，输出格式：哈希 日期 作者 主题）。\n' +
        '【何时使用】：了解项目最近变更、查看某个文件的修改历史。\n' +
        '【禁止使用 run_command 执行 git log】：本工具是只读操作。',
      parameters: {
        type: 'object',
        properties: {
          work_dir: { type: 'string', description: '工作目录，默认 cwd' },
          limit: { type: 'integer', description: '显示多少条提交，默认 10，最大 50', minimum: 1, maximum: 50 },
          file: { type: 'string', description: '仅显示某文件的提交历史' },
          with_stat: { type: 'boolean', description: '是否包含改动统计 (--stat)，默认 false' },
          ref: { type: 'string', description: '显示某个分支/ref 的日志' },
        },
      },
    },
  },

  // ── Web 网络工具 ─────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description:
        '抓取网页内容并转为可读文本（自动剥离 HTML 标签 / 脚本 / 样式）。\n' +
        '【何时使用】：用户提供具体 URL 时获取内容、阅读文档、查看 API 返回等。\n' +
        '【限制】：单次最多 1MB 响应；输出截断到 max_chars 指定的字符数。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '要抓取的 HTTP/HTTPS URL' },
          max_chars: { type: 'integer', description: '返回的最大字符数，默认 8000，最大 50000', minimum: 100, maximum: 50000 },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        '搜索引擎查询（基于 DuckDuckGo HTML 端点，免 API key）。\n' +
        '【何时使用】：需要查找最新资料、解决错误信息、查找文档链接等。\n' +
        '【返回】：标题、URL、摘要 三列形式。\n' +
        '【限制】：依赖 DuckDuckGo 可访问性；用户在受限网络下可能返回失败，此时请改用 web_fetch 直接抓取已知 URL。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
          max_results: { type: 'integer', description: '返回的最大结果数，默认 5，最大 20', minimum: 1, maximum: 20 },
        },
        required: ['query'],
      },
    },
  },

  // ── 命令执行 ─────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        '在系统 shell 中执行命令。默认 30s 超时；命令黑名单（rm -rf 等）会被拒绝。\n' +
        '【严禁使用 run_command 代替专用工具】：\n' +
        '  - 读文件 → read_file（不要用 cat/head/tail/sed）\n' +
        '  - 写文件 → write_file（不要用 echo > / cat << EOF）\n' +
        '  - 编辑文件 → edit_file（不要用 sed/awk）\n' +
        '  - 列目录 → list_files（不要用 ls/dir）\n' +
        '  - 搜索文件名 → glob_files（不要用 find）\n' +
        '  - 搜索文件内容 → grep_code（不要用 grep/rg/findstr）\n' +
        '  - 定时任务 → scheduler_create_task（不要用 cron/at/schtasks）\n' +
        'run_command 仅适合：构建/测试命令（npm test、pytest）、git 读操作（git status / git diff / git log）、运行用户脚本等无对应专用工具的场景。',
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
        '在小牛马应用内创建一条定时任务。这是处理"设置定时""每天X点提醒我""每周X""每隔N分钟""X分钟后提醒我""指定日期执行"等需求的【唯一】正确方式——严禁使用 run_command 操作系统 crontab / launchctl / launchd / schtasks，也严禁使用 wait 工具来延迟提醒。' +
        ' 默认建议 kind=agent，触发时直接让小牛马 Agent 执行 user_input 中的指令；只有用户明确要求执行 shell 命令时才用 kind=shell。' +
        ' 特别注意：即使是"10秒后提醒我"这种短时间的延迟提醒，也必须使用 schedule_type=delay 创建定时任务，而不是用 wait 工具阻塞等待。定时任务可以在应用重启后继续执行，而 wait 工具会阻塞会话且无法持久化。',
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
            enum: ['interval', 'daily', 'weekly', 'once', 'delay'],
            description: 'interval=每隔 N 分钟；daily=每天 HH:mm；weekly=每周指定一天 HH:mm；once=指定日期时间只执行一次；delay=延迟 N 分钟后执行一次',
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
          execute_at: {
            type: 'string',
            description: '【schedule_type=once 必填】ISO8601 格式的日期时间，如 2026-06-15T14:30:00',
          },
          delay_seconds: {
            type: 'integer',
            description: '【schedule_type=delay 必填】延迟执行的秒数 (>=1)。支持精确到秒，如 10 秒后提醒。超过 60 秒会显示为"X分Y秒"，超过 3600 秒显示为"X时Y分Z秒"。',
            minimum: 1,
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
          schedule_type: { type: 'string', enum: ['interval', 'daily', 'weekly', 'once', 'delay'] },
          interval_minutes: { type: 'integer', minimum: 1, maximum: 1440 },
          time: { type: 'string' },
          week_day: { type: 'integer', minimum: 0, maximum: 6 },
          execute_at: { type: 'string', description: 'ISO8601 格式的日期时间，如 2026-06-15T14:30:00' },
          delay_seconds: { type: 'integer', minimum: 1, description: '延迟执行的秒数' },
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

  // ── 技能管理 ─────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'skill_list',
      description: '列出所有已安装的技能，返回技能列表（含 id、名称、描述、启用状态等）。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'skill_get',
      description: '获取指定技能的详细信息（完整 JSON 定义）。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '技能 id' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'skill_install',
      description: '安装一个新技能。传入完整的技能 JSON 对象（包含 id、name、description、triggers、systemPromptAddition 等字段）。技能将保存到用户目录并立即启用。',
      parameters: {
        type: 'object',
        properties: {
          skill_json: { type: 'string', description: '技能的完整 JSON 字符串，必须符合 AgentSkill 格式' },
        },
        required: ['skill_json'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'skill_update',
      description: '更新已存在的用户技能。传入完整的更新后技能 JSON 对象。只能更新用户安装的技能，不能修改内置技能。',
      parameters: {
        type: 'object',
        properties: {
          skill_json: { type: 'string', description: '更新后的技能完整 JSON 字符串' },
        },
        required: ['skill_json'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'skill_toggle',
      description: '启用或禁用指定技能。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '技能 id' },
          enabled: { type: 'boolean', description: 'true=启用, false=禁用' },
        },
        required: ['id', 'enabled'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'skill_delete',
      description: '删除用户安装的技能。内置技能无法删除，只能禁用。删除前请与用户确认。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '技能 id' },
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
      description: '暂停指定毫秒数（最大 60000）。仅在确实需要等待外部事件时使用，避免浪费用户时间。【严禁】用于"延迟提醒""X分钟后通知我"等定时类需求——这类需求必须使用 scheduler_create_task 工具创建定时任务。wait 工具会阻塞当前会话，且无法持久化（应用重启后丢失），仅适用于如等待文件生成、等待端口就绪等技术场景。',
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
export type ToolGroupId = 'file' | 'code' | 'git' | 'command' | 'data' | 'scheduler' | 'skill' | 'system' | 'control' | 'web'

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
    id: 'code',
    label: '代码搜索',
    description: '正则代码搜索 / Glob 文件查找（专为编程任务设计，避免回退到 grep/find 命令）',
    toolNames: ['grep_code', 'glob_files'],
  },
  {
    id: 'git',
    label: 'Git 只读',
    description: 'Git 工作区状态 / 差异 / 提交历史查询（只读，无需二次确认）',
    toolNames: ['git_status', 'git_diff', 'git_log'],
  },
  {
    id: 'web',
    label: '网络工具',
    description: '抓取网页 / 搜索引擎查询（依赖网络可访问性）',
    toolNames: ['web_fetch', 'web_search'],
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
    id: 'skill',
    label: '技能管理',
    description: '查看/安装/更新/删除/启停 Agent 技能（关闭后 Agent 不能管理技能）',
    toolNames: [
      'skill_list',
      'skill_get',
      'skill_install',
      'skill_update',
      'skill_toggle',
      'skill_delete',
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
