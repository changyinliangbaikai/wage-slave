/**
 * Agent 写入审计日志
 *
 * 记录会改变本地状态的工具调用，便于用户追溯 Agent 何时写了哪个文件、
 * 改了哪条待办或调整了哪个定时任务。日志只记录摘要，不保存完整文件内容。
 */

import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import log from 'electron-log/main'

export interface AgentAuditEntry {
  tool: string
  action: string
  target?: string
  summary?: string
}

function localDateStr(d: Date = new Date()): string {
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function recordAgentAudit(entry: AgentAuditEntry): void {
  try {
    const dir = path.join(app.getPath('userData'), 'agent-audit')
    fs.mkdirSync(dir, { recursive: true })
    const day = localDateStr()
    const file = path.join(dir, `${day}.jsonl`)
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      ...entry,
    })
    fs.appendFileSync(file, line + '\n', 'utf-8')
  } catch (e) {
    log.warn('[AgentAudit] 写入审计日志失败:', e)
  }
}
