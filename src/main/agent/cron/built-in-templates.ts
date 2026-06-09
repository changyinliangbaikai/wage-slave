/**
 * Agent Cron 内置模板
 */

import type { AgentCronTemplate } from './types'

const notify = { onStart: false, onComplete: true, onError: true }

export const AGENT_CRON_TEMPLATES: AgentCronTemplate[] = [
  {
    id: 'morning-plan',
    icon: '☀️',
    name: '晨间计划整理',
    description: '上班后读取今日待办，给出优先级和节奏建议',
    template: {
      name: '每天 9:30 今日规划建议',
      description: '基于今日待办给出工作节奏建议',
      schedule: { type: 'daily', time: '09:30' },
      agentTask: {
        goal: '看一下今日待办，按优先级和精力分配，给我一份“今天怎么干”的建议',
        maxSteps: 20,
        timeoutMinutes: 10,
      },
      notify,
      enabled: true,
    },
  },
  {
    id: 'evening-review',
    icon: '🌙',
    name: '晚间复盘',
    description: '下班前自动回顾今日完成情况',
    template: {
      name: '每天 18:30 收工复盘',
      description: '自动回顾今日完成情况，生成结构化复盘',
      schedule: { type: 'daily', time: '18:30' },
      agentTask: {
        goal: '复盘今天：完成了什么、还差什么、明天重点',
        maxSteps: 20,
        timeoutMinutes: 10,
      },
      notify,
      enabled: true,
    },
  },
  {
    id: 'weekly-report',
    icon: '📊',
    name: '周报生成',
    description: '每周一自动汇总过去 7 天日志',
    template: {
      name: '每周一 9:30 上周周报',
      description: '基于过去 7 天工作日志生成标准周报',
      schedule: { type: 'weekly', weekDay: 1, time: '09:30' },
      agentTask: {
        goal: '基于过去 7 天的工作日志，生成上周周报：本周概览、分项目进展、下周计划',
        maxSteps: 20,
        timeoutMinutes: 15,
      },
      notify,
      enabled: true,
    },
  },
  {
    id: 'desktop-organize',
    icon: '🧹',
    name: '桌面整理',
    description: '每天扫描桌面并给出整理建议',
    template: {
      name: '每天 17:50 桌面整理建议',
      description: '扫描桌面文件，按类型生成整理方案',
      schedule: { type: 'daily', time: '17:50' },
      agentTask: {
        goal: '扫描桌面文件，按类型归类，生成一份整理方案，不要移动或删除文件',
        maxSteps: 20,
        timeoutMinutes: 10,
      },
      notify,
      enabled: true,
    },
  },
  {
    id: 'git-backup',
    icon: '💾',
    name: 'Git 备份提醒',
    description: '提醒检查重要仓库状态，不自动提交或推送',
    template: {
      name: '每周五 17:30 Git 状态检查',
      description: '读取常用仓库状态并提醒用户手动备份',
      schedule: { type: 'weekly', weekDay: 5, time: '17:30' },
      agentTask: {
        goal: '提醒我检查本周重要 Git 仓库的未提交改动，只给出检查建议，不要自动 commit 或 push',
        maxSteps: 20,
        timeoutMinutes: 10,
      },
      notify,
      enabled: true,
    },
  },
  {
    id: 'break-reminder',
    icon: '🫖',
    name: '休息提醒',
    description: '固定间隔提醒短休息',
    template: {
      name: '每 90 分钟休息提醒',
      description: '提醒用户起身、喝水、休息眼睛',
      schedule: { type: 'interval', intervalMinutes: 90 },
      agentTask: {
        goal: '提醒我休息一下，喝水并放松眼睛，用一句简短的话提示',
        maxSteps: 8,
        timeoutMinutes: 5,
      },
      notify,
      enabled: true,
    },
  },
]
