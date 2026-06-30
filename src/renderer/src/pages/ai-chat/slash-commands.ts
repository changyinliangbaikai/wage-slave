/**
 * AI 对话斜杠命令
 *
 * 当用户在输入框开头输入 `/` 时弹出命令菜单。
 * 选中一条后：
 *   - 有 `resolve`：执行异步逻辑，把返回内容写入输入框（可能包装提示词）
 *   - 只有 `template`：直接把模板填入输入框，用户继续编辑
 *
 * 命令按「与小牛马模块联动」和「通用提示词」两组划分。
 */

import { IPC } from '@shared/ipc-channels'
import type { DailyLog, TodoItem } from '@shared/types'

const api = (window as any).electronAPI

/** 本地日期 YYYY-MM-DD */
function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 本周一 YYYY-MM-DD */
function weekStart(): string {
  const d = new Date()
  const day = d.getDay()
  d.setDate(d.getDate() - (day === 0 ? 6 : day - 1))
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function formatTodos(todos: TodoItem[]): string {
  if (todos.length === 0) return '（今日暂无待办）'
  return todos.map(t => `- [${t.status === 'done' ? 'x' : ' '}] ${t.title}${t.priority === 'high' ? ' 【紧急】' : ''}`).join('\n')
}

function formatDailyLog(log: DailyLog | null): string {
  if (!log) return '（无记录）'
  const parts: string[] = []
  if (log.plan_input) parts.push(`**计划原文**：${log.plan_input}`)
  if (log.todos?.length) parts.push(`**待办**：\n${formatTodos(log.todos)}`)
  if (log.eod_log) parts.push(`**晚间日志**：${log.eod_log}`)
  return parts.join('\n\n') || '（无记录）'
}

export interface SlashCommand {
  id: string
  trigger: string        // 如 '/today-log'
  label: string          // 菜单显示名
  icon: string
  hint: string           // 简短说明
  group: 'system' | 'xiaoniu' | 'prompt' | 'favorite'
  /** 异步产出插入到输入框的文本；返回 null 表示取消 */
  resolve?: () => Promise<string | null>
  /** 静态模板；与 resolve 二选一 */
  template?: string
  /**
   * true 时菜单选中后由调用方立即提交，不需要用户再补充内容；
   * 用于状态控制型命令（/help、/compact 等）
   */
  immediate?: boolean
  /** 是否可被用户删除（收藏项为 true） */
  deletable?: boolean
}

export const SLASH_COMMANDS: SlashCommand[] = [
  // ── 系统命令（Slash Commands，前端拦截执行） ──────
  {
    id: 'cmd-help',
    trigger: '/help',
    label: '命令帮助',
    icon: '❓',
    hint: '查看所有 slash 命令的用法',
    group: 'system',
    template: '/help',
    immediate: true,
  },
  {
    id: 'cmd-plan',
    trigger: '/plan',
    label: '计划模式',
    icon: '🗂️',
    hint: '先写 plan/proposal.md 等待批准，未批准前禁止改代码',
    group: 'system',
    template: '/plan ',
  },
  {
    id: 'cmd-model',
    trigger: '/model',
    label: '切换模型',
    icon: '🤖',
    hint: '/model <模型名> 切换 Agent 模型；不带参数查看当前',
    group: 'system',
    template: '/model ',
  },
  {
    id: 'cmd-effort',
    trigger: '/effort',
    label: '推理强度',
    icon: '🧠',
    hint: '/effort low|medium|high 调整 reasoning 模型推理深度',
    group: 'system',
    template: '/effort ',
  },
  {
    id: 'cmd-compact',
    trigger: '/compact',
    label: '压缩会话',
    icon: '🗜️',
    hint: '永久压缩历史消息为摘要，节约上下文 tokens',
    group: 'system',
    template: '/compact',
    immediate: true,
  },

  // ── 小牛马联动 ─────────────────────────────
  {
    id: 'today-log',
    trigger: '/今日日志',
    label: '今日日志',
    icon: '📒',
    hint: '把今天的工作日志内容作为上下文',
    group: 'xiaoniu',
    resolve: async () => {
      const log = await api.invoke(IPC.LOG_GET, today()) as DailyLog | null
      return `请基于我今天的工作日志回答我的问题。

${formatDailyLog(log)}

---

（请替换这段文字为你的问题）`
    },
  },
  {
    id: 'today-todos',
    trigger: '/今日待办',
    label: '今日待办',
    icon: '📋',
    hint: '把今天的待办列表作为上下文',
    group: 'xiaoniu',
    resolve: async () => {
      const todos = await api.invoke(IPC.TODOS_GET, today()) as TodoItem[]
      return `这是我今天的待办清单：

${formatTodos(todos)}

---

（请替换这段文字为你的问题，例如：帮我排个优先级 / 估算所需时间）`
    },
  },
  {
    id: 'week-logs',
    trigger: '/本周日志',
    label: '本周日志',
    icon: '📅',
    hint: '读取本周所有工作日志作为上下文',
    group: 'xiaoniu',
    resolve: async () => {
      const logs = await api.invoke(IPC.LOGS_RANGE, { start: weekStart(), end: today() }) as DailyLog[]
      if (logs.length === 0) return '本周暂无工作日志记录。'
      const lines = logs
        .sort((a, b) => a.date.localeCompare(b.date))
        .map(l => `### ${l.date}\n${formatDailyLog(l)}`)
        .join('\n\n')
      return `这是我本周的工作日志：

${lines}

---

（请替换这段文字为你的问题，例如：帮我写周报 / 总结亮点）`
    },
  },
  {
    id: 'spell-check',
    trigger: '/错别字',
    label: '错别字检查',
    icon: '🔍',
    hint: '对接下来粘贴的文本做错别字检查',
    group: 'xiaoniu',
    template: `请对以下文本做错别字和语法检查，用表格列出「原文」「建议修改」「理由」：

（粘贴文本到这里）`,
  },

  // ── 通用提示词 ─────────────────────────────
  {
    id: 'translate-en',
    trigger: '/翻译英文',
    label: '翻译为英文',
    icon: '🌐',
    hint: '把接下来的中文翻译成地道英文',
    group: 'prompt',
    template: `请把下面内容翻译成地道的英文，保持原意不变，风格自然、简洁：

（粘贴中文到这里）`,
  },
  {
    id: 'translate-zh',
    trigger: '/翻译中文',
    label: '翻译为中文',
    icon: '🇨🇳',
    hint: '把接下来的英文翻译成中文',
    group: 'prompt',
    template: `请把下面内容翻译成中文，保持原意，风格自然流畅：

（粘贴英文到这里）`,
  },
  {
    id: 'polish',
    trigger: '/润色',
    label: '润色文本',
    icon: '✨',
    hint: '对接下来的文本做书面化 + 精简优化',
    group: 'prompt',
    template: `请对下面的文本做润色优化：保留原意，改为书面语，去除冗余，修正错别字和语法。最后列出主要修改点。

（粘贴原文到这里）`,
  },
  {
    id: 'summarize',
    trigger: '/总结',
    label: '总结要点',
    icon: '📊',
    hint: '提取核心结论 + 关键要点 + 行动项',
    group: 'prompt',
    template: `请帮我总结下面内容：给出核心结论（1-2 句）、关键要点（列表）、行动项（如有）。

（粘贴内容到这里）`,
  },
  {
    id: 'explain-code',
    trigger: '/解释代码',
    label: '解释代码',
    icon: '💻',
    hint: '逐行解释接下来粘贴的代码',
    group: 'prompt',
    template: `请解释下面这段代码的用途和实现思路，先给 1 句话总结，然后逐段说明关键逻辑。若发现 bug / 可优化点请指出：

\`\`\`
（粘贴代码到这里）
\`\`\``,
  },
  {
    id: 'mermaid-flow',
    trigger: '/流程图',
    label: '画流程图',
    icon: '🧩',
    hint: '用 Mermaid 画流程图（可自动渲染为图表）',
    group: 'prompt',
    template: `请根据下面描述画一张 Mermaid 流程图，只输出一个 \`\`\`mermaid 代码块，使用 flowchart TD 语法，节点中文清晰，箭头逻辑正确：

（在这里描述流程，例如：用户注册 → 发送验证码 → 验证成功 → 进入首页；失败则返回错误提示）`,
  },
  {
    id: 'mermaid-seq',
    trigger: '/时序图',
    label: '画时序图',
    icon: '🔀',
    hint: '用 Mermaid 画时序图（sequenceDiagram）',
    group: 'prompt',
    template: `请根据下面描述画一张 Mermaid 时序图，只输出一个 \`\`\`mermaid 代码块，使用 sequenceDiagram 语法，标注参与者和消息内容：

（在这里描述交互场景，例如：前端 -> 网关 -> 鉴权服务 -> 业务服务 的登录流程）`,
  },
  {
    id: 'mermaid-arch',
    trigger: '/架构图',
    label: '画架构图',
    icon: '🏗️',
    hint: '用 Mermaid 画系统架构图',
    group: 'prompt',
    template: `请根据下面描述画一张 Mermaid 系统架构图，只输出一个 \`\`\`mermaid 代码块，使用 flowchart LR 或 graph TB，用 subgraph 分层标注模块关系：

（在这里描述系统，例如：前端 / 网关 / 微服务 / 消息队列 / 数据库 的层次关系）`,
  },
]
