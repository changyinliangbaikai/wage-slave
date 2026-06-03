/**
 * Skill 匹配与注入
 *
 * 职责：
 *  - 根据用户输入命中已启用 skill 的 triggers
 *  - 命中多个时，选"命中关键词最长"的（更具体优先）
 *  - 生成注入到 System Prompt 的技能段落文本
 */

import log from 'electron-log/main'
import type { AgentSkill } from '@shared/types'
import { getEnabledSkills } from './store'

/** 匹配结果 */
export interface SkillMatch {
  skill: AgentSkill
  /** 命中的关键词 */
  matchedTrigger: string
}

/**
 * 根据用户输入匹配一个最合适的已启用 skill
 * @param userInput 用户本轮输入
 * @returns 命中的 skill 与关键词；无命中返回 null
 */
export function matchSkill(userInput: string): SkillMatch | null {
  const text = (userInput ?? '').toLowerCase()
  if (!text.trim()) return null

  const skills = getEnabledSkills()
  let best: SkillMatch | null = null

  for (const skill of skills) {
    for (const trigger of skill.triggers) {
      const t = trigger.toLowerCase().trim()
      if (!t) continue
      if (text.includes(t)) {
        // 命中关键词更长 → 更具体，优先
        if (!best || t.length > best.matchedTrigger.length) {
          best = { skill, matchedTrigger: trigger }
        }
      }
    }
  }

  if (best) {
    log.info(`[Skill] 命中技能「${best.skill.name}」(trigger="${best.matchedTrigger}")`)
  }
  return best
}

/**
 * 生成注入 System Prompt 的技能段落
 * 在原始 systemPromptAddition 外包一层统一标识，便于 LLM 识别"当前激活技能"
 */
export function buildSkillPromptAddition(skill: AgentSkill): string {
  const tools = skill.recommendedTools?.length
    ? `\n推荐工具：${skill.recommendedTools.join(', ')}`
    : ''
  return `\n\n# 已激活技能：${skill.icon} ${skill.name}\n${skill.systemPromptAddition}${tools}\n（请优先按本技能的步骤执行；若用户意图与技能不符，可灵活调整）`
}
