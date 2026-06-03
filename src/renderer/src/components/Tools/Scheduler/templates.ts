/**
 * Agent Cron 模板（Phase 3.4）
 *
 * 内置一组定时 Agent 任务示例，用户在新建任务时可一键应用，
 * 模板会预填表单字段（任务名 / 类型 / 调度 / Agent 输入），
 * 应用后用户可继续微调再保存
 */

import type { TaskSchedule } from '@shared/types'

/** Agent Cron 模板 */
export interface AgentCronTemplate {
  id: string
  /** emoji 图标 */
  icon: string
  /** 模板显示名（同时作为默认任务名） */
  name: string
  /** 一句话描述 */
  description: string
  /** 默认调度配置 */
  schedule: TaskSchedule
  /** 触发时投喂给 Agent 的输入文本 */
  userInput: string
}

/** 内置 Agent Cron 模板 */
export const AGENT_CRON_TEMPLATES: AgentCronTemplate[] = [
  {
    id: 'daily-evening-review',
    icon: '🌙',
    name: '每天 18:30 收工复盘',
    description: '下班前自动回顾今日完成情况，生成结构化复盘',
    schedule: { type: 'daily', time: '18:30' },
    userInput: '复盘今天：完成了什么、还差什么、明天重点',
  },
  {
    id: 'weekly-monday-report',
    icon: '📊',
    name: '每周一 9:30 上周周报',
    description: '周一上午自动汇总上周工作日志，生成标准周报',
    schedule: { type: 'weekly', weekDay: 1, time: '09:30' },
    userInput: '基于过去 7 天的工作日志，生成上周周报：本周概览、分项目进展、下周计划',
  },
  {
    id: 'daily-morning-plan',
    icon: '☀️',
    name: '每天 9:30 今日规划建议',
    description: '上班后基于今日待办给出工作节奏建议',
    schedule: { type: 'daily', time: '09:30' },
    userInput: '看一下今日待办，按优先级和精力分配，给我一份"今天怎么干"的建议',
  },
  {
    id: 'daily-night-inspiration',
    icon: '💡',
    name: '每天 21:00 灵感速记',
    description: '睡前提醒记录今天的想法、感悟、有趣的发现',
    schedule: { type: 'daily', time: '21:00' },
    userInput: '提醒我：今天有什么想法、感悟或有趣的发现？没有的话就略过',
  },
  {
    id: 'weekly-friday-recap',
    icon: '🎯',
    name: '每周五 17:00 周回顾',
    description: '周五下午回顾本周完成度，规划下周重点',
    schedule: { type: 'weekly', weekDay: 5, time: '17:00' },
    userInput: '本周回顾：完成了什么、卡点在哪、下周重点是什么',
  },
  {
    id: 'daily-expense-reminder',
    icon: '💰',
    name: '每天 22:00 记账提示',
    description: '睡前提醒记录今日开销，配合"记账助手"技能',
    schedule: { type: 'daily', time: '22:00' },
    userInput: '提醒我记一下今天的开销，把金额、类别整理成一行追加到日志',
  },
]
