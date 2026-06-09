/**
 * Skill 匹配与注入
 *
 * 职责：
 *  - 根据用户输入命中已启用 skill 的 triggers / tags / name / description
 *  - 命中多个时按权重与关键词长度选最相关的一个
 *  - 生成注入到 System Prompt 的技能段落文本
 */

import log from 'electron-log/main'
import type { SkillConfig, SkillWithState } from './types'
import { getEnabledSkills } from './store'

/** 匹配结果 */
export interface SkillMatch {
  skill: SkillWithState
  /** 命中的关键词或字段 */
  matchedTrigger: string
  /** 命中来源：触发词 / 标签 / 名称 / 描述 */
  matchedBy: 'trigger' | 'tag' | 'name' | 'description'
  /** 匹配分数，用于调试和排序 */
  score: number
}

/**
 * 根据用户输入匹配一个最合适的已启用 skill
 * @param userInput 用户本轮输入
 * @returns 命中的 skill 与关键词；无命中返回 null
 */
export function matchSkill(userInput: string): SkillMatch | null {
  const matches = matchSkills(userInput)
  const best = matches[0] ?? null
  if (best) {
    log.info(`[Skill] 命中技能「${best.skill.name}」(${best.matchedBy}="${best.matchedTrigger}" score=${best.score})`)
  }
  return best
}

/** 返回所有命中的 Skill，按相关性从高到低排序 */
export function matchSkills(userInput: string): SkillMatch[] {
  const text = (userInput ?? '').toLowerCase()
  if (!text.trim()) return []

  const skills = getEnabledSkills()
  const matches: SkillMatch[] = []

  for (const skill of skills) {
    const candidate = scoreSkillMatch(skill, text)
    if (candidate) matches.push(candidate)
  }

  return matches.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return b.matchedTrigger.length - a.matchedTrigger.length
  })
}

function scoreSkillMatch(skill: SkillWithState, text: string): SkillMatch | null {
  let best: SkillMatch | null = null

  const consider = (
    matchedTrigger: string,
    matchedBy: SkillMatch['matchedBy'],
    weight: number,
  ) => {
    const token = matchedTrigger.toLowerCase().trim()
    if (!token || !text.includes(token)) return
    const score = weight + Math.min(token.length, 20) / 100
    if (
      !best ||
      score > best.score ||
      (score === best.score && matchedTrigger.length > best.matchedTrigger.length)
    ) {
      best = { skill, matchedTrigger, matchedBy, score }
    }
  }

  for (const trigger of skill.triggers) {
    consider(trigger, 'trigger', 10)
  }

  for (const tag of skill.meta?.tags ?? []) {
    consider(tag, 'tag', 5)
  }

  consider(skill.name, 'name', 3)

  for (const keyword of splitDescriptionKeywords(skill.description)) {
    consider(keyword, 'description', 1)
  }

  return best
}

function splitDescriptionKeywords(description: string): string[] {
  return description
    .split(/[\s,，。；;、/|]+/)
    .map(word => word.trim())
    .filter(word => word.length >= 2)
}

/**
 * 生成注入 System Prompt 的技能段落
 * 在原始 systemPromptAddition 外包一层统一标识，便于 LLM 识别"当前激活技能"
 */
export function buildSkillPromptAddition(skill: SkillWithState & { config?: SkillConfig }): string {
  const tools = skill.recommendedTools?.length
    ? `\n推荐工具：${skill.recommendedTools.join(', ')}`
    : ''
  const config = skill.config && Object.keys(skill.config).length > 0
    ? `\n用户配置：\n${JSON.stringify(skill.config, null, 2)}`
    : ''
  return `\n\n# 已激活技能：${skill.icon} ${skill.name}\n${skill.systemPromptAddition}${tools}${config}\n（请优先按本技能的步骤执行；若用户意图与技能不符，可灵活调整）`
}
