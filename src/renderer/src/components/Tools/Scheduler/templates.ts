/**
 * Agent 任务模板（旧定时任务面板）
 *
 * 内置一组定时 Agent 任务示例，用户在新建任务时可一键应用，
 * 模板会预填表单字段（任务名 / 类型 / 调度 / Agent 输入），
 * 应用后用户可继续微调再保存
 */

import type { TaskSchedule } from '@shared/types'

/** Agent 任务模板 */
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

/** 内置 Agent 任务模板。内容与独立 Agent Cron 模板保持同类目，避免两个入口展示不一致 */
export const AGENT_CRON_TEMPLATES: AgentCronTemplate[] = [
  {
    id: 'morning-plan',
    icon: '☀️',
    name: '每天 9:30 今日规划建议',
    description: '上班后基于今日待办给出工作节奏建议',
    schedule: { type: 'daily', time: '09:30' },
    userInput: '看一下今日待办，按优先级和精力分配，给我一份"今天怎么干"的建议',
  },
  {
    id: 'evening-review',
    icon: '🌙',
    name: '每天 18:30 收工复盘',
    description: '下班前自动回顾今日完成情况，生成结构化复盘',
    schedule: { type: 'daily', time: '18:30' },
    userInput: '复盘今天：完成了什么、还差什么、明天重点',
  },
  {
    id: 'weekly-report',
    icon: '📊',
    name: '每周一 9:30 上周周报',
    description: '周一上午自动汇总上周工作日志，生成标准周报',
    schedule: { type: 'weekly', weekDay: 1, time: '09:30' },
    userInput: '基于过去 7 天的工作日志，生成上周周报：本周概览、分项目进展、下周计划',
  },
  {
    id: 'desktop-organize',
    icon: '🧹',
    name: '每天 17:50 桌面整理建议',
    description: '扫描桌面文件，按类型生成整理方案',
    schedule: { type: 'daily', time: '17:50' },
    userInput: '扫描桌面文件，按类型归类，生成一份整理方案，不要移动或删除文件',
  },
  {
    id: 'git-backup',
    icon: '💾',
    name: '每周五 17:30 Git 状态检查',
    description: '读取常用仓库状态并提醒用户手动备份',
    schedule: { type: 'weekly', weekDay: 5, time: '17:30' },
    userInput: '提醒我检查本周重要 Git 仓库的未提交改动，只给出检查建议，不要自动 commit 或 push',
  },
  {
    id: 'break-reminder',
    icon: '🫖',
    name: '每 90 分钟休息提醒',
    description: '提醒用户起身、喝水、休息眼睛',
    schedule: { type: 'interval', intervalMinutes: 90 },
    userInput: '提醒我休息一下，喝水并放松眼睛，用一句简短的话提示',
  },
]
