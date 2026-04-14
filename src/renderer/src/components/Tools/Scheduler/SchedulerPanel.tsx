/**
 * 定时任务管理面板
 * - 任务列表（含状态指示器）
 * - 新建/编辑任务表单
 * - 手动执行、启用/禁用、删除
 */

import { useState, useEffect, useCallback } from 'react'
import { IPC } from '@shared/ipc-channels'
import type { ScheduledTask, TaskSchedule, ScheduleType } from '@shared/types'
import TaskLogViewer from './TaskLogViewer'
import './SchedulerPanel.css'

interface Props {
  onBack: () => void
}

type ViewMode = 'list' | 'form' | 'logs'

const WEEK_DAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 格式化调度描述 */
function formatSchedule(s: TaskSchedule): string {
  if (s.type === 'interval') return `每 ${s.intervalMinutes ?? 60} 分钟`
  if (s.type === 'daily') return `每天 ${s.time ?? '09:00'}`
  if (s.type === 'weekly') return `每${WEEK_DAYS[s.weekDay ?? 1]} ${s.time ?? '09:00'}`
  return '未知'
}

/** 格式化时间为简短显示 */
function formatTime(isoStr?: string): string {
  if (!isoStr) return '-'
  const d = new Date(isoStr)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 状态图标 */
function statusIcon(status?: string): string {
  if (status === 'running') return '🔄'
  if (status === 'success') return '✅'
  if (status === 'failed') return '❌'
  return '⏳'
}

// ── 默认表单值 ─────────────────────────────────
const defaultForm = {
  name: '',
  command: '',
  workDir: '',
  scheduleType: 'daily' as ScheduleType,
  intervalMinutes: 60,
  time: '09:00',
  weekDay: 1,
  enabled: true,
}

export default function SchedulerPanel({ onBack }: Props) {
  const [tasks, setTasks] = useState<ScheduledTask[]>([])
  const [view, setView] = useState<ViewMode>('list')
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null)
  const [logTaskId, setLogTaskId] = useState<string>('')
  const [logTaskName, setLogTaskName] = useState<string>('')
  const [form, setForm] = useState({ ...defaultForm })
  const [saving, setSaving] = useState(false)

  // 加载任务列表
  const loadTasks = useCallback(async () => {
    const result = await window.electronAPI.invoke(IPC.SCHEDULER_LIST_TASKS) as ScheduledTask[]
    setTasks(result || [])
  }, [])

  useEffect(() => {
    loadTasks()
    // 定时刷新任务状态（每 5 秒）
    const timer = setInterval(loadTasks, 5000)
    return () => clearInterval(timer)
  }, [loadTasks])

  // 打开新建表单
  const handleNew = useCallback(() => {
    setEditingTaskId(null)
    setForm({ ...defaultForm })
    setView('form')
  }, [])

  // 打开编辑表单
  const handleEdit = useCallback((task: ScheduledTask) => {
    setEditingTaskId(task.id)
    setForm({
      name: task.name,
      command: task.command,
      workDir: task.workDir,
      scheduleType: task.schedule.type,
      intervalMinutes: task.schedule.intervalMinutes ?? 60,
      time: task.schedule.time ?? '09:00',
      weekDay: task.schedule.weekDay ?? 1,
      enabled: task.enabled,
    })
    setView('form')
  }, [])

  // 保存任务
  const handleSave = useCallback(async () => {
    if (!form.name.trim() || !form.command.trim()) return

    setSaving(true)
    const schedule: TaskSchedule = {
      type: form.scheduleType,
      ...(form.scheduleType === 'interval' && { intervalMinutes: form.intervalMinutes }),
      ...(form.scheduleType !== 'interval' && { time: form.time }),
      ...(form.scheduleType === 'weekly' && { weekDay: form.weekDay }),
    }

    await window.electronAPI.invoke(IPC.SCHEDULER_SAVE_TASK, {
      ...(editingTaskId && { id: editingTaskId }),
      name: form.name.trim(),
      command: form.command.trim(),
      workDir: form.workDir,
      schedule,
      enabled: form.enabled,
    })

    setSaving(false)
    await loadTasks()
    setView('list')
  }, [form, editingTaskId, loadTasks])

  // 删除任务
  const handleDelete = useCallback(async (taskId: string) => {
    if (!confirm('确定要删除这个定时任务吗？')) return
    await window.electronAPI.invoke(IPC.SCHEDULER_DELETE_TASK, taskId)
    await loadTasks()
  }, [loadTasks])

  // 切换启用/禁用
  const handleToggle = useCallback(async (taskId: string) => {
    await window.electronAPI.invoke(IPC.SCHEDULER_TOGGLE_TASK, taskId)
    await loadTasks()
  }, [loadTasks])

  // 手动执行
  const handleRun = useCallback(async (taskId: string) => {
    await window.electronAPI.invoke(IPC.SCHEDULER_RUN_TASK, taskId)
    // 短暂延迟后刷新状态
    setTimeout(loadTasks, 500)
  }, [loadTasks])

  // 查看日志
  const handleViewLogs = useCallback((task: ScheduledTask) => {
    setLogTaskId(task.id)
    setLogTaskName(task.name)
    setView('logs')
  }, [])

  // 选择工作目录
  const handleSelectDir = useCallback(async () => {
    const dir = await window.electronAPI.invoke(IPC.SCHEDULER_SELECT_DIR) as string
    if (dir) setForm(f => ({ ...f, workDir: dir }))
  }, [])

  // ── 日志视图 ──────────────────────────────────
  if (view === 'logs') {
    return (
      <TaskLogViewer
        taskId={logTaskId}
        taskName={logTaskName}
        onBack={() => setView('list')}
      />
    )
  }

  // ── 表单视图 ──────────────────────────────────
  if (view === 'form') {
    return (
      <div className="scheduler-panel">
        <div className="panel-header">
          <button className="btn-back" onClick={() => setView('list')}>← 返回</button>
          <h3>{editingTaskId ? '编辑任务' : '新建任务'}</h3>
        </div>

        <div className="task-form">
          {/* 任务名称 */}
          <div className="form-group">
            <label>任务名称</label>
            <input
              type="text"
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder="例如：每日数据备份"
              className="form-input"
            />
          </div>

          {/* 执行命令 */}
          <div className="form-group">
            <label>执行命令</label>
            <textarea
              value={form.command}
              onChange={e => setForm(f => ({ ...f, command: e.target.value }))}
              placeholder="例如：python /path/to/script.py"
              className="form-textarea"
              rows={3}
            />
          </div>

          {/* 工作目录 */}
          <div className="form-group">
            <label>工作目录（可选）</label>
            <div className="dir-select-row">
              <input
                type="text"
                value={form.workDir}
                onChange={e => setForm(f => ({ ...f, workDir: e.target.value }))}
                placeholder="命令执行时的工作目录"
                className="form-input dir-input"
              />
              <button className="btn-browse" onClick={handleSelectDir}>浏览</button>
            </div>
          </div>

          {/* 调度方式 */}
          <div className="form-group">
            <label>调度方式</label>
            <div className="schedule-type-tabs">
              <button
                className={`schedule-tab ${form.scheduleType === 'interval' ? 'active' : ''}`}
                onClick={() => setForm(f => ({ ...f, scheduleType: 'interval' }))}
              >
                间隔执行
              </button>
              <button
                className={`schedule-tab ${form.scheduleType === 'daily' ? 'active' : ''}`}
                onClick={() => setForm(f => ({ ...f, scheduleType: 'daily' }))}
              >
                每日执行
              </button>
              <button
                className={`schedule-tab ${form.scheduleType === 'weekly' ? 'active' : ''}`}
                onClick={() => setForm(f => ({ ...f, scheduleType: 'weekly' }))}
              >
                每周执行
              </button>
            </div>

            {/* 间隔分钟 */}
            {form.scheduleType === 'interval' && (
              <div className="schedule-detail">
                <span>每</span>
                <input
                  type="number"
                  min={1}
                  max={1440}
                  value={form.intervalMinutes}
                  onChange={e => setForm(f => ({ ...f, intervalMinutes: Number(e.target.value) || 60 }))}
                  className="form-input-small"
                />
                <span>分钟执行一次</span>
              </div>
            )}

            {/* 每日时间 */}
            {form.scheduleType === 'daily' && (
              <div className="schedule-detail">
                <span>每天</span>
                <input
                  type="time"
                  value={form.time}
                  onChange={e => setForm(f => ({ ...f, time: e.target.value }))}
                  className="form-input-small"
                />
                <span>执行</span>
              </div>
            )}

            {/* 每周时间 */}
            {form.scheduleType === 'weekly' && (
              <div className="schedule-detail">
                <span>每</span>
                <select
                  value={form.weekDay}
                  onChange={e => setForm(f => ({ ...f, weekDay: Number(e.target.value) }))}
                  className="form-select"
                >
                  {WEEK_DAYS.map((name, idx) => (
                    <option key={idx} value={idx}>{name}</option>
                  ))}
                </select>
                <input
                  type="time"
                  value={form.time}
                  onChange={e => setForm(f => ({ ...f, time: e.target.value }))}
                  className="form-input-small"
                />
                <span>执行</span>
              </div>
            )}
          </div>

          {/* 启用状态 */}
          <div className="form-group form-row">
            <label>创建后立即启用</label>
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={e => setForm(f => ({ ...f, enabled: e.target.checked }))}
              className="form-checkbox"
            />
          </div>

          {/* 操作按钮 */}
          <div className="form-actions">
            <button
              className="btn-save"
              onClick={handleSave}
              disabled={!form.name.trim() || !form.command.trim() || saving}
            >
              {saving ? '保存中...' : '保存任务'}
            </button>
            <button className="btn-cancel" onClick={() => setView('list')}>
              取消
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── 列表视图 ──────────────────────────────────
  return (
    <div className="scheduler-panel">
      <div className="panel-header">
        <button className="btn-back" onClick={onBack}>← 返回</button>
        <h3>⏰ 定时任务</h3>
        <button className="btn-new-task" onClick={handleNew}>+ 新建</button>
      </div>

      {tasks.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">📭</div>
          <p>暂无定时任务</p>
          <button className="btn-new-task-large" onClick={handleNew}>创建第一个任务</button>
        </div>
      ) : (
        <div className="task-list">
          {tasks.map(task => (
            <div key={task.id} className={`task-card ${task.enabled ? '' : 'disabled'}`}>
              <div className="task-header">
                <span className="task-status">{statusIcon(task.lastRunStatus)}</span>
                <span className="task-name">{task.name}</span>
                <span className={`task-enable-badge ${task.enabled ? 'on' : 'off'}`}>
                  {task.enabled ? '运行中' : '已禁用'}
                </span>
              </div>

              <div className="task-info">
                <div className="task-command" title={task.command}>
                  <span className="info-label">命令：</span>
                  <code>{task.command}</code>
                </div>
                <div className="task-schedule">
                  <span className="info-label">调度：</span>
                  {formatSchedule(task.schedule)}
                </div>
                {task.lastRunAt && (
                  <div className="task-last-run">
                    <span className="info-label">上次执行：</span>
                    {formatTime(task.lastRunAt)}
                  </div>
                )}
              </div>

              <div className="task-actions">
                <button className="btn-action btn-run" onClick={() => handleRun(task.id)} title="立即执行">
                  ▶ 执行
                </button>
                <button className="btn-action btn-logs" onClick={() => handleViewLogs(task)} title="查看日志">
                  📋 日志
                </button>
                <button className="btn-action btn-toggle" onClick={() => handleToggle(task.id)} title={task.enabled ? '禁用' : '启用'}>
                  {task.enabled ? '⏸ 禁用' : '▶ 启用'}
                </button>
                <button className="btn-action btn-edit" onClick={() => handleEdit(task)} title="编辑">
                  ✏️ 编辑
                </button>
                <button className="btn-action btn-delete" onClick={() => handleDelete(task.id)} title="删除">
                  🗑
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
