/**
 * Skill 存储与管理
 *
 * 存储布局（app.getPath('userData')/skills/）：
 *   skills/
 *     installs.json      // 安装/启停记录（含内置 skill 的启停覆盖）
 *     user/              // 用户安装的 skill，每个一个 <id>.json
 *
 * 全局 skills（跨项目共享）：
 *   ~/.devin/skills/     // 本机全局 skill 目录
 *   ~/.agents/skills/    // 备用全局 skill 目录
 *   支持格式：
 *     - 小牛马原生格式：<id>.json 直接放在目录下
 *     - 通用 skill 标准：<skill-dir>/SKILL.md（YAML frontmatter + Markdown）
 *
 * 设计：
 *  - 内置 skill 来自 built-in.ts，恒为"已安装"，启停状态可被 installs.json 覆盖
 *  - 全局 skill 来自 ~/.devin/skills/ 和 ~/.agents/skills/，跨项目共享
 *  - 用户 / 远程 skill 落地为 user/<id>.json
 *  - 优先级：用户 > 全局 > 内置（同 id 后者覆盖前者）
 *  - 原子写入（写 .tmp 再 rename），避免半写损坏
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { app } from 'electron'
import log from 'electron-log/main'
import type { AgentSkill, SkillConfig, SkillInstallRecord, SkillWithState } from '@shared/types'
import { BUILT_IN_SKILLS } from './built-in'

const SKILLS_DIR = path.join(app.getPath('userData'), 'skills')
const INSTALLS_FILE = path.join(SKILLS_DIR, 'installs.json')
const USER_SKILLS_DIR = path.join(SKILLS_DIR, 'user')

// 全局 skills 目录（跨项目共享）
const GLOBAL_SKILLS_DIRS = [
  path.join(os.homedir(), '.devin', 'skills'),
  path.join(os.homedir(), '.agents', 'skills'),
]

// ── 目录初始化 ─────────────────────────────────

function ensureDirs(): void {
  fs.mkdirSync(SKILLS_DIR, { recursive: true })
  fs.mkdirSync(USER_SKILLS_DIR, { recursive: true })
}

/** 原子写 JSON */
function writeJsonAtomic(file: string, data: unknown): void {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
  fs.renameSync(tmp, file)
}

// ── 安装/启停记录 ──────────────────────────────

/** 读取全部安装记录 */
export function getInstallRecords(): SkillInstallRecord[] {
  ensureDirs()
  try {
    if (!fs.existsSync(INSTALLS_FILE)) return []
    return JSON.parse(fs.readFileSync(INSTALLS_FILE, 'utf-8')) as SkillInstallRecord[]
  } catch (e) {
    log.warn('[Skill] 读取安装记录失败:', e)
    return []
  }
}

function saveInstallRecords(records: SkillInstallRecord[]): void {
  ensureDirs()
  writeJsonAtomic(INSTALLS_FILE, records)
}

/** 写入或更新单条安装记录 */
function upsertInstallRecord(record: SkillInstallRecord): void {
  const records = getInstallRecords()
  const idx = records.findIndex(r => r.skillId === record.skillId)
  if (idx >= 0) records[idx] = record
  else records.push(record)
  saveInstallRecords(records)
}

function isPlainConfig(config: unknown): config is SkillConfig {
  return Boolean(config) && typeof config === 'object' && !Array.isArray(config)
}

// ── 用户 Skill 加载 ────────────────────────────

/** 加载 user 目录下的全部 skill */
export function loadUserSkills(): AgentSkill[] {
  ensureDirs()
  const result: AgentSkill[] = []
  try {
    const files = fs.readdirSync(USER_SKILLS_DIR).filter(f => f.endsWith('.json'))
    for (const f of files) {
      try {
        const raw = fs.readFileSync(path.join(USER_SKILLS_DIR, f), 'utf-8')
        const skill = JSON.parse(raw) as AgentSkill
        if (validateSkill(skill)) result.push(skill)
        else log.warn(`[Skill] 跳过无效 skill 文件: ${f}`)
      } catch (e) {
        log.warn(`[Skill] 解析 skill 文件失败 ${f}:`, e)
      }
    }
  } catch (e) {
    log.warn('[Skill] 读取用户 skill 目录失败:', e)
  }
  return result
}

/** 从 SKILL.md 内容解析 skill
 * 格式: YAML frontmatter + Markdown body
 * frontmatter 包含: name, description, (可选) triggers, category, icon, author, version
 */
function parseSkillFromMarkdown(
  content: string,
  skillId: string,
  skillDir: string,
): AgentSkill | null {
  // 解析 YAML frontmatter: ---\n...\n---\n
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!frontmatterMatch) {
    log.warn(`[Skill] ${skillId} 的 SKILL.md 缺少 YAML frontmatter`)
    return null
  }

  const [, yamlContent, markdownBody] = frontmatterMatch

  // 简单解析 YAML key: value 格式
  const yaml: Record<string, string | string[]> = {}
  for (const line of yamlContent.split('\n')) {
    const match = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/)
    if (match) {
      const [, key, value] = match
      // 处理数组格式 (以 - 开头)
      if (value.trim().startsWith('- ')) {
        yaml[key] = value
          .trim()
          .split('\n')
          .map((v) => v.trim().replace(/^- /, ''))
          .filter(Boolean)
      } else {
        yaml[key] = value.trim()
      }
    }
  }

  const name = (yaml.name as string) || skillId
  const description = (yaml.description as string) || ''
  const triggers = Array.isArray(yaml.triggers)
    ? yaml.triggers
    : typeof yaml.triggers === 'string'
      ? yaml.triggers.split(',').map((t) => t.trim())
      : [skillId, name]

  // 构建 AgentSkill 对象
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const skill: AgentSkill = {
    id: skillId,
    name,
    description,
    category: (yaml.category as AgentSkill['category']) || 'custom',
    icon: (yaml.icon as string) || '🔧',
    author: (yaml.author as string) || 'unknown',
    version: (yaml.version as string) || '1.0.0',
    triggers,
    systemPromptAddition: `## 当前技能：${name}\n\n${markdownBody.trim()}`,
    scope: 'user',
  }

  return skill
}

/** 加载全局 skills 目录 (~/.devin/skills/ 和 ~/.agents/skills/) 下的 skill
 * 支持格式：
 * 1. 直接放在目录下的 <id>.json 文件（小牛马原生格式）
 * 2. 子目录形式：<skill-dir>/SKILL.md（通用 skill 标准）
 */
export function loadGlobalSkills(): AgentSkill[] {
  const result: AgentSkill[] = []
  for (const dir of GLOBAL_SKILLS_DIRS) {
    try {
      if (!fs.existsSync(dir)) {
        continue
      }
      const entries = fs.readdirSync(dir, { withFileTypes: true })

      for (const entry of entries) {
        try {
          // 格式1: 直接放在目录下的 .json 文件（小牛马原生格式）
          if (entry.isFile() && entry.name.endsWith('.json')) {
            const raw = fs.readFileSync(path.join(dir, entry.name), 'utf-8')
            const skill = JSON.parse(raw) as AgentSkill
            if (validateSkill(skill)) {
              skill.scope = 'user'
              result.push(skill)
            } else {
              log.warn(`[Skill] 跳过无效全局 skill 文件: ${entry.name}`)
            }
            continue
          }

          // 格式2: 子目录形式，尝试读取 <dir>/SKILL.md（通用 skill 标准）
          if (entry.isDirectory()) {
            const skillMdPath = path.join(dir, entry.name, 'SKILL.md')
            if (!fs.existsSync(skillMdPath)) {
              continue
            }

            const content = fs.readFileSync(skillMdPath, 'utf-8')
            const skill = parseSkillFromMarkdown(content, entry.name, path.join(dir, entry.name))
            if (skill) {
              result.push(skill)
              log.info(`[Skill] 从 SKILL.md 加载全局 skill: ${skill.name} (id=${skill.id})`)
            }
          }
        } catch (e) {
          log.warn(`[Skill] 解析全局 skill 失败 ${entry.name}:`, e)
        }
      }
    } catch (e) {
      log.warn(`[Skill] 读取全局 skill 目录失败 ${dir}:`, e)
    }
  }
  if (result.length > 0) {
    log.info(`[Skill] 已加载 ${result.length} 个全局 skill 从 ${GLOBAL_SKILLS_DIRS.join(', ')}`)
  }
  return result
}

/** 校验一个 skill 是否字段合法 */
export function validateSkill(s: unknown): s is AgentSkill {
  if (!s || typeof s !== 'object') return false
  const sk = s as Record<string, unknown>
  return (
    typeof sk.id === 'string' &&
    sk.id.length > 0 &&
    typeof sk.name === 'string' &&
    typeof sk.description === 'string' &&
    typeof sk.systemPromptAddition === 'string' &&
    Array.isArray(sk.triggers)
  )
}

// ── 查询 ───────────────────────────────────────

/** 获取全部可用 skill（内置 + 全局 + 用户），附带安装/启用状态 */
export function getAllSkills(): SkillWithState[] {
  const records = getInstallRecords()
  const recordMap = new Map(records.map(r => [r.skillId, r]))

  const toState = (s: AgentSkill, installed: boolean): SkillWithState => ({
    ...s,
    installed,
    // 默认启用；installs.json 中若存在记录则以记录为准
    enabled: recordMap.get(s.id)?.enabled ?? true,
    config: recordMap.get(s.id)?.config ?? {},
  })

  const builtins = BUILT_IN_SKILLS.map(s => toState(s, true))
  const globalSkills = loadGlobalSkills().map(s => toState(s, true))
  const userSkills = loadUserSkills().map(s => toState(s, true))

  // 优先级：用户 > 全局 > 内置（同 id 则后者覆盖前者）
  const merged = new Map<string, SkillWithState>()
  for (const s of builtins) merged.set(s.id, s)
  for (const s of globalSkills) merged.set(s.id, s)
  for (const s of userSkills) merged.set(s.id, s)
  return [...merged.values()]
}

/** 仅返回"已启用"的 skill（matcher 注入用） */
export function getEnabledSkills(): SkillWithState[] {
  return getAllSkills().filter(s => s.enabled)
}

/** 按 id 获取 skill */
export function getSkillById(id: string): SkillWithState | null {
  return getAllSkills().find(s => s.id === id) ?? null
}

/** 按分类获取 */
export function getSkillsByCategory(category: string): SkillWithState[] {
  return getAllSkills().filter(s => s.category === category)
}

/** 关键词搜索（名称 / 描述 / triggers / tags） */
export function searchSkills(query: string): SkillWithState[] {
  const q = query.trim().toLowerCase()
  if (!q) return getAllSkills()
  return getAllSkills().filter(
    s =>
      s.name.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      s.triggers.some(t => t.toLowerCase().includes(q)) ||
      (s.meta?.tags ?? []).some(t => t.toLowerCase().includes(q)),
  )
}

// ── 启停 / 安装 / 卸载 ─────────────────────────

/** 切换 skill 启用状态，返回切换后的状态 */
export function toggleSkill(id: string, enabled?: boolean): SkillWithState | null {
  const skill = getSkillById(id)
  if (!skill) {
    log.warn(`[Skill] toggle 失败，skill 不存在: ${id}`)
    return null
  }
  const next = enabled ?? !skill.enabled
  upsertInstallRecord({
    skillId: id,
    installedAt: getInstallRecords().find(r => r.skillId === id)?.installedAt ?? new Date().toISOString(),
    source: skill.scope,
    enabled: next,
    config: skill.config ?? {},
  })
  log.info(`[Skill] ${id} 启用状态 → ${next}`)
  return { ...skill, enabled: next }
}

/** 保存单个 skill 的用户配置 */
export function updateSkillConfig(id: string, config: SkillConfig): SkillWithState | null {
  if (!isPlainConfig(config)) {
    throw new Error('Skill 配置必须是 JSON 对象')
  }
  const skill = getSkillById(id)
  if (!skill) {
    log.warn(`[Skill] 配置保存失败，skill 不存在: ${id}`)
    return null
  }
  upsertInstallRecord({
    skillId: id,
    installedAt: getInstallRecords().find(r => r.skillId === id)?.installedAt ?? new Date().toISOString(),
    source: skill.scope,
    enabled: skill.enabled,
    config,
  })
  log.info(`[Skill] 已保存配置: ${id}`)
  return { ...skill, config }
}

/**
 * 安装（落地）一个 skill 到 user 目录，并写安装记录
 * 同 id 直接覆盖（用于更新）
 */
export function saveUserSkill(skill: AgentSkill, source: 'user' | 'remote' = 'user'): SkillWithState {
  ensureDirs()
  if (!validateSkill(skill)) {
    throw new Error('Skill 格式非法：缺少 id/name/description/systemPromptAddition/triggers')
  }
  const normalized: AgentSkill = { ...skill, scope: source }
  const file = path.join(USER_SKILLS_DIR, `${skill.id}.json`)
  writeJsonAtomic(file, normalized)
  upsertInstallRecord({
    skillId: skill.id,
    installedAt: new Date().toISOString(),
    source,
    enabled: true,
    config: {},
  })
  log.info(`[Skill] 已安装 skill: ${skill.id} (${source})`)
  return { ...normalized, installed: true, enabled: true }
}

/** 卸载用户 skill（内置 skill 不可卸载，只能停用） */
export function deleteUserSkill(id: string): boolean {
  const isBuiltin = BUILT_IN_SKILLS.some(s => s.id === id)
  if (isBuiltin) {
    log.warn(`[Skill] 内置 skill 不可卸载，仅停用: ${id}`)
    toggleSkill(id, false)
    return false
  }
  const file = path.join(USER_SKILLS_DIR, `${id}.json`)
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file)
  } catch (e) {
    log.warn(`[Skill] 删除 skill 文件失败 ${id}:`, e)
    return false
  }
  // 移除安装记录
  const records = getInstallRecords().filter(r => r.skillId !== id)
  saveInstallRecords(records)
  log.info(`[Skill] 已卸载 skill: ${id}`)
  return true
}
