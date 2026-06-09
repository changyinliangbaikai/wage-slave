/**
 * 内置 Skills
 *
 * Skill 是预定义的工作流模板：命中 triggers 后，把 systemPromptAddition
 * 注入到 Agent 的 System Prompt，引导 LLM 按既定步骤完成一类任务。
 *
 * 设计约束（与安全策略对齐）：
 *  - 不在步骤里诱导 run_command 执行 rm / mv 等被黑名单拦截的命令
 *  - 删除 / 移动类操作一律"生成方案 + 让用户手动执行"
 *  - 写入统一走 write_file / append_log / save_todo 等专用工具
 */

import type { AgentSkill } from '@shared/types'

const BUILT_IN_SKILL_DATE = '2026-06-04'

export const BUILT_IN_SKILLS: AgentSkill[] = [
  // ── 1. 每日复盘 ─────────────────────────────
  {
    id: 'daily-review',
    name: '每日复盘',
    description: '回顾今天的待办与日志，生成结构化复盘并写入日志',
    category: 'productivity',
    icon: '🌙',
    author: '小小牛马',
    version: '1.0.0',
    triggers: ['复盘', '日复盘', '今天总结', '每日总结', 'daily review', 'review today'],
    systemPromptAddition: `## 当前技能：每日复盘
执行步骤：
1. 调用 get_today_log 读取今天的日志，调用 get_todos 读取今天的待办
2. 分析：今天完成了什么、还差什么、卡点在哪
3. 生成结构化复盘（Markdown）：
   - ✅ 今日完成
   - ⏳ 未完成 / 顺延
   - 💡 收获与反思
   - 🎯 明日重点
4. 询问用户是否用 append_log 把复盘写入今日日志`,
    recommendedTools: ['get_today_log', 'get_todos', 'append_log'],
    scope: 'builtin',
    meta: { tags: ['复盘', '总结', '日志'], createdAt: BUILT_IN_SKILL_DATE, updatedAt: BUILT_IN_SKILL_DATE },
  },

  // ── 2. 周报生成 ─────────────────────────────
  {
    id: 'weekly-report',
    name: '周报生成',
    description: '读取本周工作日志，按主题归类生成标准周报',
    category: 'productivity',
    icon: '📊',
    author: '小小牛马',
    version: '1.0.0',
    triggers: ['周报', '本周总结', '周总结', 'weekly report', 'week summary'],
    systemPromptAddition: `## 当前技能：周报生成
执行步骤：
1. 调用 get_logs_range 获取最近 7 天的工作日志
2. 分析每天的工作内容与完成情况
3. 按项目 / 主题归类，提炼关键产出
4. 生成标准格式周报（Markdown）：
   - 本周概览（1-2 句）
   - 分项目进展
   - 数据 / 成果
   - 下周计划
5. 询问用户是否用 write_file 保存到文件（默认建议存到桌面）`,
    recommendedTools: ['get_logs_range', 'write_file', 'append_log'],
    scope: 'builtin',
    meta: { tags: ['周报', '总结', '日志'], createdAt: BUILT_IN_SKILL_DATE, updatedAt: BUILT_IN_SKILL_DATE },
  },

  // ── 3. 代码审查 ─────────────────────────────
  {
    id: 'code-review',
    name: '代码审查',
    description: '读取指定代码文件，给出问题清单与改进建议',
    category: 'code',
    icon: '🔍',
    author: '小小牛马',
    version: '1.0.0',
    triggers: ['代码审查', '审查代码', 'review 代码', 'code review', '看看这段代码', '帮我看代码'],
    systemPromptAddition: `## 当前技能：代码审查
执行步骤：
1. 用 read_file 读取目标代码文件（必要时用 list_files / search_files 定位）
2. 从以下维度审查：
   - 🐛 潜在 Bug 与边界问题
   - 🔒 安全风险
   - ⚡ 性能问题
   - 📐 可读性与命名
   - 🧪 测试覆盖建议
3. 输出问题清单（按严重程度排序），每条给出：位置、问题、建议改法
4. 如用户要求修复，用 edit_file 做最小化改动，改完复读确认
注意：不要擅自大规模重写；改动前先说明方案`,
    recommendedTools: ['read_file', 'list_files', 'search_files', 'edit_file'],
    scope: 'builtin',
    meta: { tags: ['代码', '审查', '重构'], createdAt: BUILT_IN_SKILL_DATE, updatedAt: BUILT_IN_SKILL_DATE },
  },

  // ── 4. 桌面整理 ─────────────────────────────
  {
    id: 'desktop-organize',
    name: '桌面整理',
    description: '扫描桌面文件，按类型归类并生成整理方案',
    category: 'file',
    icon: '🧹',
    author: '小小牛马',
    version: '1.0.0',
    triggers: ['整理桌面', '桌面整理', '清理桌面', 'organize desktop', '收拾桌面'],
    systemPromptAddition: `## 当前技能：桌面整理
执行步骤：
1. 用 list_files 列出桌面（desktopPath）下的文件
2. 按类型归类：📄 文档 / 🖼️ 图片 / 📦 压缩包 / 💻 代码 / 🎬 媒体 / 其他
3. 生成整理方案（Markdown 表格）：建议的目标文件夹 + 对应文件清单
4. 用 run_command 仅执行 mkdir 创建分类目录（会经用户确认）
重要安全约束：
- 禁止用 run_command 执行 mv / rm 移动或删除文件（会被拒绝）
- 移动文件请在方案中清晰列出，建议用户手动拖拽，或逐个用户确认
- 你的核心价值是"给出清晰可执行的整理方案"，而非强行搬动文件`,
    recommendedTools: ['list_files', 'run_command'],
    scope: 'builtin',
    meta: { tags: ['文件', '整理', '桌面'], createdAt: BUILT_IN_SKILL_DATE, updatedAt: BUILT_IN_SKILL_DATE },
  },

  // ── 5. 邮件助手 ─────────────────────────────
  {
    id: 'email-assistant',
    name: '邮件助手',
    description: '起草、润色和归纳邮件内容，生成清晰的主题与正文',
    category: 'writing',
    icon: '✉️',
    author: '小小牛马',
    version: '1.0.0',
    triggers: ['写邮件', '邮件助手', '回复邮件', '邮件草稿', 'email', 'mail'],
    systemPromptAddition: `## 当前技能：邮件助手
执行步骤：
1. 先识别邮件场景：通知 / 汇报 / 催办 / 致谢 / 拒绝 / 跟进
2. 如用户提供原邮件或附件，用 read_file 读取并提炼关键信息
3. 生成邮件主题、称呼、正文、结尾署名；语气默认专业、简洁、克制
4. 如用户要求多版本，给出正式版 / 简短版 / 口语版
5. 如用户要求保存，用 write_file 保存为 markdown 草稿
重要：不要自行发送邮件；只生成草稿和回复建议`,
    recommendedTools: ['read_file', 'write_file'],
    scope: 'builtin',
    meta: { tags: ['邮件', '写作', '回复'], createdAt: BUILT_IN_SKILL_DATE, updatedAt: BUILT_IN_SKILL_DATE },
  },

  // ── 6. 数据分析 ─────────────────────────────
  {
    id: 'data-analysis',
    name: '数据分析',
    description: '读取数据文件或日志，做结构化统计、趋势判断和结论输出',
    category: 'productivity',
    icon: '📈',
    author: '小小牛马',
    version: '1.0.0',
    triggers: ['数据分析', '分析数据', '统计一下', '趋势分析', 'data analysis', 'analyze data'],
    systemPromptAddition: `## 当前技能：数据分析
执行步骤：
1. 明确分析对象、口径和输出格式；缺少口径时先问一个关键问题
2. 如数据在文件中，用 read_file 分段读取；如来自日志，用 get_logs_range 获取
3. 提炼指标、分组、异常点、趋势与可能原因
4. 输出结构：
   - 数据范围与口径
   - 关键指标
   - 异常 / 风险
   - 结论与建议
5. 如用户要求保存，用 write_file 输出分析报告
注意：不要编造没有在数据中出现的数值；不确定处明确标注`,
    recommendedTools: ['read_file', 'get_logs_range', 'write_file'],
    scope: 'builtin',
    meta: { tags: ['数据', '分析', '统计'], createdAt: BUILT_IN_SKILL_DATE, updatedAt: BUILT_IN_SKILL_DATE },
  },

  // ── 7. 会议记录整理 ─────────────────────────
  {
    id: 'meeting-notes',
    name: '会议记录整理',
    description: '把零散会议记录整理成结构化纪要与待办',
    category: 'writing',
    icon: '📝',
    author: '小小牛马',
    version: '1.0.0',
    triggers: ['会议记录', '整理会议', '会议纪要', 'meeting notes', '整理记录'],
    systemPromptAddition: `## 当前技能：会议记录整理
执行步骤：
1. 用 read_file 读取原始会议记录文件（或直接使用用户粘贴的内容）
2. 整理成结构化纪要（Markdown）：
   - 📌 会议主题 / 时间 / 参与者
   - 🗣️ 关键讨论点
   - ✅ 决议事项
   - 📋 待办 Action Items（含负责人 / 截止时间）
3. 询问用户是否：
   - 用 write_file 保存纪要到文件
   - 用 save_todo 把 Action Items 写入待办清单`,
    recommendedTools: ['read_file', 'write_file', 'save_todo'],
    scope: 'builtin',
    meta: { tags: ['会议', '纪要', '待办'], createdAt: BUILT_IN_SKILL_DATE, updatedAt: BUILT_IN_SKILL_DATE },
  },

  // ── 8. 文本润色 ─────────────────────────────
  {
    id: 'text-polish',
    name: '文本润色',
    description: '润色、精简或改写文本，保持原意提升表达',
    category: 'writing',
    icon: '✨',
    author: '小小牛马',
    version: '1.0.0',
    triggers: ['润色', '改写', '帮我修改文案', 'polish', '优化文字', '改改这段'],
    systemPromptAddition: `## 当前技能：文本润色
执行步骤：
1. 确认润色目标：更正式 / 更口语 / 更精简 / 更有感染力（不确定就问一句）
2. 如内容在文件中，用 read_file 读取
3. 给出润色后的版本，并简要说明改动点（改了什么、为什么）
4. 保持原意不变，不要添油加醋编造事实
5. 如用户要求，用 write_file 保存或 edit_file 就地替换原文`,
    recommendedTools: ['read_file', 'write_file', 'edit_file'],
    scope: 'builtin',
    meta: { tags: ['写作', '润色', '翻译'], createdAt: BUILT_IN_SKILL_DATE, updatedAt: BUILT_IN_SKILL_DATE },
  },
]
