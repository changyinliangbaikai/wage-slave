/**
 * Skill 市场（发现）
 *
 * 设计：
 *  - 优先从远程市场拉取 skill 列表
 *  - 远程不可用（无服务器 / 超时 / 报错）时，回退到本地精选 CURATED_MARKET
 *    保证 UI 始终有内容可展示、可一键安装
 *  - 市场条目本身就是完整的 AgentSkill，可直接安装到 user 目录
 */

import log from 'electron-log/main'
import type { MarketSkillItem } from '@shared/types'

/** 远程市场地址（占位；当前无真实服务时自动回退本地精选） */
export const DEFAULT_MARKET_URL = 'https://skills.xiaoniuma.app/index.json'

const FETCH_TIMEOUT_MS = 8_000

/**
 * 本地精选市场条目
 * 这些不在内置 BUILT_IN_SKILLS 中，作为"可发现并安装"的扩展技能
 */
const CURATED_MARKET: MarketSkillItem[] = [
  {
    id: 'translate-zh-en',
    name: '中英互译',
    description: '在中文与英文之间互译，保留语气与专有名词',
    category: 'writing',
    icon: '🌐',
    author: '小小牛马官方',
    version: '1.0.0',
    triggers: ['翻译', '翻译成英文', '翻译成中文', 'translate', '英译中', '中译英'],
    systemPromptAddition: `## 当前技能：中英互译
执行步骤：
1. 自动判断源语言，翻译到目标语言（中↔英）
2. 保留专有名词、代码、品牌名不翻译
3. 给出译文后，附 1 句风格说明（正式/口语）
4. 长文本可分段翻译，保持术语一致`,
    recommendedTools: ['read_file', 'write_file'],
    scope: 'remote',
    meta: { tags: ['翻译', '写作'], createdAt: '2026-06-03', updatedAt: '2026-06-03' },
    installs: 1280,
    rating: 4.8,
  },
  {
    id: 'json-doctor',
    name: 'JSON 医生',
    description: '校验、格式化、修复 JSON，并解释错误',
    category: 'code',
    icon: '🩺',
    author: '小小牛马官方',
    version: '1.0.0',
    triggers: ['json', '格式化 json', '校验 json', 'json 报错', '修复 json'],
    systemPromptAddition: `## 当前技能：JSON 医生
执行步骤：
1. 如内容在文件中，用 read_file 读取
2. 校验 JSON 合法性；若报错，指出具体位置与原因
3. 给出修复后的格式化 JSON（2 空格缩进）
4. 如用户要求，用 write_file 保存修复结果`,
    recommendedTools: ['read_file', 'write_file', 'edit_file'],
    scope: 'remote',
    meta: { tags: ['JSON', '代码', '格式化'], createdAt: '2026-06-03', updatedAt: '2026-06-03' },
    installs: 960,
    rating: 4.6,
  },
  {
    id: 'git-commit-helper',
    name: 'Git 提交助手',
    description: '查看改动并生成规范的 commit message',
    category: 'code',
    icon: '🔧',
    author: '小小牛马官方',
    version: '1.0.0',
    triggers: ['commit', '提交信息', 'git 提交', 'commit message', '生成提交'],
    systemPromptAddition: `## 当前技能：Git 提交助手
执行步骤：
1. 用 run_command 执行 git status 与 git diff --stat 查看改动（只读，安全）
2. 按 Conventional Commits 规范生成提交信息：
   - 格式：type(scope): subject
   - type：feat/fix/docs/refactor/test/chore 等
3. 给出 1 条主信息 + 可选的 body 说明
重要：只读取改动信息，不要自动执行 git commit / git push（由用户手动执行）`,
    recommendedTools: ['run_command'],
    scope: 'remote',
    meta: { tags: ['git', '代码'], createdAt: '2026-06-03', updatedAt: '2026-06-03' },
    installs: 1530,
    rating: 4.9,
  },
  {
    id: 'expense-logger',
    name: '记账助手',
    description: '把口语化消费记录整理成结构化账目',
    category: 'productivity',
    icon: '💰',
    author: '小小牛马官方',
    version: '1.0.0',
    triggers: ['记账', '记一笔', '消费记录', 'expense', '花了'],
    systemPromptAddition: `## 当前技能：记账助手
执行步骤：
1. 从用户口语中提取：金额、类别、备注、时间
2. 整理成一行结构化记录：日期 | 类别 | 金额 | 备注
3. 用 append_log 追加到今日日志，或用 write_file 写入指定账本文件
4. 如用户问本月花销，用 get_logs_range 汇总统计`,
    recommendedTools: ['append_log', 'write_file', 'get_logs_range'],
    scope: 'remote',
    meta: { tags: ['记账', '生产力'], createdAt: '2026-06-03', updatedAt: '2026-06-03' },
    installs: 740,
    rating: 4.5,
  },
]

/**
 * 拉取市场 skill 列表
 * @param url 市场地址（默认 DEFAULT_MARKET_URL）
 * @returns 市场条目；远程不可用时返回本地精选
 */
export async function fetchMarketSkills(url: string = DEFAULT_MARKET_URL): Promise<MarketSkillItem[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const resp = await fetch(url, { signal: controller.signal })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const data = (await resp.json()) as { skills?: MarketSkillItem[] }
    const list = Array.isArray(data.skills) ? data.skills : []
    if (list.length === 0) throw new Error('市场返回空列表')
    log.info(`[Skill] 远程市场返回 ${list.length} 个 skill`)
    return list
  } catch (e) {
    // 远程不可用 → 回退本地精选（这是预期内的降级，不当作错误）
    log.info('[Skill] 远程市场不可用，使用本地精选:', e instanceof Error ? e.message : String(e))
    return CURATED_MARKET
  } finally {
    clearTimeout(timer)
  }
}

/** 按 id 从市场（含精选）取一个条目 */
export async function getMarketSkill(id: string): Promise<MarketSkillItem | null> {
  const list = await fetchMarketSkills()
  return list.find(s => s.id === id) ?? null
}
