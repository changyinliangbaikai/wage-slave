/**
 * 现有 ScheduledTask → Agent Cron 一键迁移
 *
 * 迁移不会删除原任务；可选 disableOriginal=true 时会停用原任务。
 */

import type { AgentCronTask } from './types'
import type { ScheduledTask } from '@shared/types'
import { listTasks, saveTask } from '../../tools/task-scheduler'
import { listAgentCrons, saveAgentCron } from './scheduler'

export interface AgentCronMigrationResult {
  migrated: AgentCronTask[]
  skipped: Array<{ id: string; name: string; reason: string }>
}

export function migrateScheduledTasksToAgentCrons(params?: {
  taskIds?: string[]
  disableOriginal?: boolean
}): AgentCronMigrationResult {
  const taskIds = new Set(params?.taskIds ?? [])
  const tasks = listTasks().filter(t => taskIds.size === 0 || taskIds.has(t.id))
  const existingCrons = listAgentCrons()
  const migrated: AgentCronTask[] = []
  const skipped: AgentCronMigrationResult['skipped'] = []

  for (const task of tasks) {
    const existing = existingCrons.find(c => c.description.includes(migrationSourceMarker(task.id)))
    if (existing) {
      skipped.push({ id: task.id, name: task.name, reason: `已迁移为 Agent Cron：${existing.name}` })
      if (params?.disableOriginal && task.enabled) {
        saveTask({ ...task, enabled: false })
      }
      continue
    }

    const kind = task.kind ?? 'shell'
    if (kind === 'agent' && !task.agentTask?.userInput?.trim()) {
      skipped.push({ id: task.id, name: task.name, reason: '原 Agent 任务输入为空' })
      continue
    }
    if (kind === 'shell' && !task.command?.trim()) {
      skipped.push({ id: task.id, name: task.name, reason: '原任务命令为空' })
      continue
    }

    const cron = saveAgentCron({
      name: `${task.name}（Agent Cron）`,
      description: `由旧定时任务迁移（${migrationSourceMarker(task.id)}）`,
      schedule: task.schedule,
      enabled: task.enabled,
      agentTask: {
        goal: buildMigratedGoal(task),
        context: task.agentCron?.context,
        allowedTools: task.agentCron?.allowedTools,
        maxSteps: task.agentCron?.maxSteps ?? 20,
        timeoutMinutes: task.agentCron?.timeoutMinutes ?? 10,
      },
      notify: task.agentCron?.notify ?? { onStart: false, onComplete: true, onError: true },
    })
    migrated.push(cron)

    if (params?.disableOriginal && task.enabled) {
      saveTask({ ...task, enabled: false })
    }
  }

  return { migrated, skipped }
}

function migrationSourceMarker(taskId: string): string {
  return `sourceScheduledTask:${taskId}`
}

function buildMigratedGoal(task: ScheduledTask): string {
  if ((task.kind ?? 'shell') === 'agent') {
    return extractGoal(task.agentTask?.userInput ?? '', task.agentCron?.context)
  }

  const workDir = task.workDir?.trim()
  return [
    `执行从旧定时任务迁移来的任务「${task.name}」。`,
    '请优先使用 run_command，并在命令执行失败时给出错误原因和下一步建议。',
    `命令：${task.command}`,
    workDir ? `工作目录：${workDir}` : '',
  ].filter(Boolean).join('\n')
}

function extractGoal(userInput: string, context?: string): string {
  if (!context) return userInput
  const marker = `\n\n上下文：\n${context}`
  return userInput.endsWith(marker) ? userInput.slice(0, -marker.length) : userInput
}
