/**
 * 任务执行日志查看器
 * 显示指定任务的历史执行记录和输出日志
 */

import { useState, useEffect, useCallback } from 'react'
import { IPC } from '@shared/ipc-channels'
import type { TaskExecution } from '@shared/types'
import './SchedulerPanel.css'

interface Props {
  taskId: string
  taskName: string
  onBack: () => void
}

/** 格式化时间 */
function formatTime(isoStr?: string): string {
  if (!isoStr) return '-'
  const d = new Date(isoStr)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 计算耗时 */
function duration(start: string, end?: string): string {
  if (!end) return '运行中...'
  const ms = new Date(end).getTime() - new Date(start).getTime()
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`
}

/** 状态标签 */
function statusBadge(status: string): { text: string; cls: string } {
  if (status === 'running') return { text: '运行中', cls: 'badge-running' }
  if (status === 'success') return { text: '成功', cls: 'badge-success' }
  return { text: '失败', cls: 'badge-failed' }
}

export default function TaskLogViewer({ taskId, taskName, onBack }: Props) {
  const [logs, setLogs] = useState<TaskExecution[]>([])
  const [selectedLog, setSelectedLog] = useState<TaskExecution | null>(null)
  const [loading, setLoading] = useState(true)

  // 加载日志
  const loadLogs = useCallback(async () => {
    const result = await window.electronAPI.invoke(IPC.SCHEDULER_GET_LOGS, taskId) as TaskExecution[]
    setLogs(result || [])
    setLoading(false)
  }, [taskId])

  useEffect(() => {
    loadLogs()
    // 每 3 秒自动刷新（捕获运行中的任务输出更新）
    const timer = setInterval(loadLogs, 3000)
    return () => clearInterval(timer)
  }, [loadLogs])

  // 清除日志
  const handleClear = useCallback(async () => {
    if (!confirm('确定要清除该任务的所有执行日志吗？')) return
    await window.electronAPI.invoke(IPC.SCHEDULER_CLEAR_LOGS, taskId)
    setLogs([])
    setSelectedLog(null)
  }, [taskId])

  // ── 日志详情视图 ──────────────────────────────
  if (selectedLog) {
    const badge = statusBadge(selectedLog.status)
    return (
      <div className="scheduler-panel">
        <div className="panel-header">
          <button className="btn-back" onClick={() => setSelectedLog(null)}>← 返回</button>
          <h3>执行详情</h3>
        </div>

        <div className="log-detail">
          <div className="log-detail-meta">
            <div className="meta-row">
              <span className="meta-label">状态</span>
              <span className={`status-badge ${badge.cls}`}>{badge.text}</span>
            </div>
            <div className="meta-row">
              <span className="meta-label">开始时间</span>
              <span>{formatTime(selectedLog.startTime)}</span>
            </div>
            <div className="meta-row">
              <span className="meta-label">结束时间</span>
              <span>{formatTime(selectedLog.endTime)}</span>
            </div>
            <div className="meta-row">
              <span className="meta-label">耗时</span>
              <span>{duration(selectedLog.startTime, selectedLog.endTime)}</span>
            </div>
            {selectedLog.exitCode !== null && (
              <div className="meta-row">
                <span className="meta-label">退出码</span>
                <span className={selectedLog.exitCode === 0 ? 'exit-ok' : 'exit-err'}>
                  {selectedLog.exitCode}
                </span>
              </div>
            )}
          </div>

          <div className="log-output-section">
            <div className="log-output-header">
              <h4>执行输出</h4>
            </div>
            <pre className="log-output">
              {selectedLog.output || '（无输出）'}
            </pre>
          </div>
        </div>
      </div>
    )
  }

  // ── 日志列表视图 ──────────────────────────────
  return (
    <div className="scheduler-panel">
      <div className="panel-header">
        <button className="btn-back" onClick={onBack}>← 返回</button>
        <h3>📋 {taskName} - 执行日志</h3>
        {logs.length > 0 && (
          <button className="btn-clear-logs" onClick={handleClear}>清除日志</button>
        )}
      </div>

      {loading ? (
        <div className="empty-state"><p>加载中...</p></div>
      ) : logs.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">📭</div>
          <p>暂无执行记录</p>
        </div>
      ) : (
        <div className="log-list">
          {logs.map(log => {
            const badge = statusBadge(log.status)
            return (
              <div
                key={log.id}
                className="log-item"
                onClick={() => setSelectedLog(log)}
              >
                <div className="log-item-header">
                  <span className={`status-badge ${badge.cls}`}>{badge.text}</span>
                  <span className="log-time">{formatTime(log.startTime)}</span>
                  <span className="log-duration">{duration(log.startTime, log.endTime)}</span>
                </div>
                {log.output && (
                  <div className="log-preview">
                    {log.output.slice(0, 120)}{log.output.length > 120 ? '...' : ''}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
