/**
 * Skill 类型入口
 *
 * 业务类型统一定义在 shared/types.ts，这里保留 agent/skills 子模块内的
 * 类型入口，便于主进程 Skill 代码按模块边界引用。
 */

export type {
  AgentSkill,
  MarketSkillItem,
  SkillCategory,
  SkillConfig,
  SkillInstallRecord,
  SkillScope,
  SkillWithState,
} from '@shared/types'
