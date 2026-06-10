/**
 * 定时任务管理面板
 * - 任务列表（含状态指示器）
 * - 新建/编辑任务表单
 * - 手动执行、启用/禁用、删除
 */

import { useState, useEffect, useCallback } from 'react'
import { IPC } from '@shared/ipc-channels'
import type { ScheduledTask, TaskSchedule, ScheduleType, TaskKind } from '@shared/types'
import TaskLogViewer from './TaskLogViewer'
import { AGENT_CRON_TEMPLATES, type AgentCronTemplate } from './templates'
import {
  parseTaskFromNL,
  stopScheduledExecution,
  useOnSchedulerTaskUpdate,
  useOnSchedulerTasksChanged,
} from '../../../hooks/useIPC'
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
  if (s.type === 'once') {
    const date = s.executeAt ? new Date(s.executeAt) : null
    return date && !isNaN(date.getTime())
      ? `一次性 ${date.toLocaleString('zh-CN')}`
      : `一次性 ${s.executeAt ?? '未指定'}`
  }
  if (s.type === 'delay') {
    const secs = s.delaySeconds ?? 0
    if (secs < 60) return `${secs}秒后执行`
    if (secs < 3600) {
      const mins = Math.floor(secs / 60)
      const remainingSecs = secs % 60
      return remainingSecs === 0 ? `${mins}分钟后执行` : `${mins}分${remainingSecs}秒后执行`
    }
    const hrs = Math.floor(secs / 3600)
    const mins = Math.floor((secs % 3600) / 60)
    const remainingSecs = secs % 60
    if (mins === 0 && remainingSecs === 0) return `${hrs}小时后执行`
    if (remainingSecs === 0) return `${hrs}时${mins}分后执行`
    return `${hrs}时${mins}分${remainingSecs}秒后执行`
  }
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
const getDefaultExecuteAt = () => {
  const d = new Date(Date.now() + 3600000)
  return d.toISOString().slice(0, 16)
}

const defaultForm = {
  name: '',
  command: '',
  workDir: '',
  kind: 'shell' as TaskKind,
  userInput: '',
  scheduleType: 'daily' as ScheduleType,
  intervalMinutes: 60,
  time: '09:00',
  weekDay: 1,
  executeAt: getDefaultExecuteAt(),
  delaySeconds: 30,
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

  // 自然语言生成任务
  const [nlOpen, setNlOpen] = useState(false)
  const [nlText, setNlText] = useState('')
  const [nlParsing, setNlParsing] = useState(false)
  const [nlError, setNlError] = useState<string | null>(null)

  // 加载任务列表
  const loadTasks = useCallback(async () => {
    const result = await window.electronAPI.invoke(IPC.SCHEDULER_LIST_TASKS) as ScheduledTask[]
    setTasks(result || [])
  }, [])

  useEffect(() => {
    loadTasks()
    // 兜底轮询（10s）：避免 IPC 推送丢失导致 UI 长时间不刷新
    const timer = setInterval(loadTasks, 10000)
    return () => clearInterval(timer)
  }, [loadTasks])

  // 订阅任务状态变化（主进程在 running/success/failed 切换时推送）
  useOnSchedulerTaskUpdate(useCallback(() => {
    // 收到状态变化立即刷新列表，UI 即时显示运行中/完成
    loadTasks()
  }, [loadTasks]))

  // 订阅任务列表 CRUD 变化（特别针对 Agent 在对话里通过 scheduler_* 工具修改的场景）
  // 短暂闪一下浮提示，让用户知道是 Agent 帮他改的
  const [crudToast, setCrudToast] = useState<string | null>(null)
  useOnSchedulerTasksChanged(useCallback((p: { action: 'create' | 'update' | 'delete' | 'toggle'; taskId?: string }) => {
    loadTasks()
    const actionText = p.action === 'create' ? '新建'
      : p.action === 'update' ? '已更新'
      : p.action === 'delete' ? '已删除'
      : '已启停'
    setCrudToast(`🐱 任务${actionText}`)
    // 3 秒后自动消失
    window.setTimeout(() => setCrudToast(null), 3000)
  }, [loadTasks]))

  // 打开新建表单
  const handleNew = useCallback(() => {
    setEditingTaskId(null)
    setForm({ ...defaultForm })
    setView('form')
  }, [])

  // 模板选择弹层
  const [templateModalOpen, setTemplateModalOpen] = useState(false)

  // 应用模板：预填 form 后跳到表单视图继续微调
  const handleApplyTemplate = useCallback((tpl: AgentCronTemplate) => {
    setEditingTaskId(null)
    setForm({
      ...defaultForm,
      name: tpl.name,
      kind: 'agent',
      userInput: tpl.userInput,
      scheduleType: tpl.schedule.type,
      intervalMinutes: tpl.schedule.intervalMinutes ?? 60,
      time: tpl.schedule.time ?? '09:00',
      weekDay: tpl.schedule.weekDay ?? 1,
      executeAt: tpl.schedule.executeAt ?? '',
      delaySeconds: tpl.schedule.delaySeconds ?? 30,
    })
    setTemplateModalOpen(false)
    setView('form')
  }, [])

  // 打开编辑表单
  const handleEdit = useCallback((task: ScheduledTask) => {
    setEditingTaskId(task.id)
    setForm({
      name: task.name,
      command: task.command,
      workDir: task.workDir,
      kind: task.kind ?? 'shell',
      userInput: task.agentTask?.userInput ?? '',
      scheduleType: task.schedule.type,
      intervalMinutes: task.schedule.intervalMinutes ?? 60,
      time: task.schedule.time ?? '09:00',
      weekDay: task.schedule.weekDay ?? 1,
      executeAt: task.schedule.executeAt ?? '',
      delaySeconds: task.schedule.delaySeconds ?? 30,
      enabled: task.enabled,
    })
    setView('form')
  }, [])

  // 保存任务
  const handleSave = useCallback(async () => {
    // 校验：名称必填；shell 模式 command 必填；agent 模式 userInput 必填
    if (!form.name.trim()) return
    if (form.kind === 'shell' && !form.command.trim()) return
    if (form.kind === 'agent' && !form.userInput.trim()) return

    setSaving(true)
    const schedule: TaskSchedule = {
      type: form.scheduleType,
      ...(form.scheduleType === 'interval' && { intervalMinutes: form.intervalMinutes }),
      ...((form.scheduleType === 'daily' || form.scheduleType === 'weekly') && { time: form.time }),
      ...(form.scheduleType === 'weekly' && { weekDay: form.weekDay }),
      ...(form.scheduleType === 'once' && { executeAt: form.executeAt || new Date(Date.now() + 3600000).toISOString() }),
      ...(form.scheduleType === 'delay' && {
        delaySeconds: form.delaySeconds,
        executeAt: new Date(Date.now() + form.delaySeconds * 1000).toISOString()
      }),
    }

    // 按 kind 装载执行体字段
    const payload = form.kind === 'agent'
      ? {
          ...(editingTaskId && { id: editingTaskId }),
          name: form.name.trim(),
          command: '',
          workDir: '',
          schedule,
          enabled: form.enabled,
          kind: 'agent' as TaskKind,
          agentTask: { userInput: form.userInput.trim() },
        }
      : {
          ...(editingTaskId && { id: editingTaskId }),
          name: form.name.trim(),
          command: form.command.trim(),
          workDir: form.workDir,
          schedule,
          enabled: form.enabled,
          kind: 'shell' as TaskKind,
        }

    await window.electronAPI.invoke(IPC.SCHEDULER_SAVE_TASK, payload)

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

  // 中止正在运行的任务（Agent 任务尤其需要）
  const handleStop = useCallback(async (taskId: string) => {
    if (!confirm('确定要终止当前正在运行的执行吗？')) return
    await stopScheduledExecution(taskId)
    // 给主进程一点时间触发 close/finally 写入 failed 状态
    setTimeout(loadTasks, 600)
  }, [loadTasks])

  // 自然语言 → 任务草稿，直接套到表单
  const handleParseNL = useCallback(async () => {
    const text = nlText.trim()
    if (!text) return
    setNlParsing(true)
    setNlError(null)
    try {
      const res = await parseTaskFromNL(text)
      if (!res.ok || !res.task) {
        setNlError(res.error || '解析失败，请改写后重试')
        return
      }
      const t = res.task
      const sched = t.schedule
      setEditingTaskId(null)
      setForm({
        ...defaultForm,
        name: t.name || '',
        kind: (t.kind ?? 'agent') as TaskKind,
        command: t.command ?? '',
        userInput: t.userInput ?? t.agentTask?.userInput ?? '',
        scheduleType: (sched?.type ?? 'daily') as ScheduleType,
        intervalMinutes: sched?.intervalMinutes ?? 60,
        time: sched?.time ?? '09:00',
        weekDay: sched?.weekDay ?? 1,
        enabled: t.enabled ?? true,
      })
      setNlOpen(false)
      setNlText('')
      setView('form')
    } catch (e) {
      setNlError(e instanceof Error ? e.message : String(e))
    } finally {
      setNlParsing(false)
    }
  }, [nlText])

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

          {/* 任务类型 */}
          <div className="form-group">
            <label>任务类型</label>
            <div className="schedule-type-tabs">
              <button
                className={`schedule-tab ${form.kind === 'shell' ? 'active' : ''}`}
                onClick={() => setForm(f => ({ ...f, kind: 'shell' }))}
              >
                🖥️ Shell 命令
              </button>
              <button
                className={`schedule-tab ${form.kind === 'agent' ? 'active' : ''}`}
                onClick={() => setForm(f => ({ ...f, kind: 'agent' }))}
              >
                🤖 Agent 任务
              </button>
            </div>
          </div>

          {form.kind === 'shell' ? (
            <>
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
            </>
          ) : (
            <>
              {/* Agent 任务描述 */}
              <div className="form-group">
                <label>Agent 任务描述</label>
                <textarea
                  value={form.userInput}
                  onChange={e => setForm(f => ({ ...f, userInput: e.target.value }))}
                  placeholder="例如：复盘今天 / 生成本周周报 / 整理桌面"
                  className="form-textarea"
                  rows={3}
                />
                <p className="form-hint" style={{ fontSize: 12, color: '#8b7a5d', margin: '4px 0 0' }}>
                  触发时会用这段文本启动 Agent，命中的技能会自动注入引导
                </p>
              </div>
            </>
          )}

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
              <button
                className={`schedule-tab ${form.scheduleType === 'once' ? 'active' : ''}`}
                onClick={() => setForm(f => ({ ...f, scheduleType: 'once' }))}
              >
                指定时间
              </button>
              <button
                className={`schedule-tab ${form.scheduleType === 'delay' ? 'active' : ''}`}
                onClick={() => setForm(f => ({ ...f, scheduleType: 'delay' }))}
              >
                延迟执行
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

            {/* 指定日期时间（一次性） */}
            {form.scheduleType === 'once' && (
              <div className="schedule-detail">
                <span>执行时间</span>
                <input
                  type="datetime-local"
                  value={form.executeAt.slice(0, 16)}
                  onChange={e => setForm(f => ({ ...f, executeAt: e.target.value }))}
                  className="form-input-small"
                  style={{ width: 200 }}
                />
                <span className="form-hint" style={{ fontSize: 12, color: '#8b7a5d', marginLeft: 8 }}>
                  任务执行后将自动禁用
                </span>
              </div>
            )}

            {/* 延迟执行 */}
            {form.scheduleType === 'delay' && (
              <div className="schedule-detail">
                <span>延迟</span>
                <input
                  type="number"
                  min={1}
                  value={form.delaySeconds}
                  onChange={e => setForm(f => ({ ...f, delaySeconds: Number(e.target.value) || 30 }))}
                  className="form-input-small"
                />
                <span>秒后执行（任务执行后将自动禁用）。支持精确到秒，超过60秒会显示为时分秒格式。</span>
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
              disabled={
                !form.name.trim() ||
                saving ||
                (form.kind === 'shell' && !form.command.trim()) ||
                (form.kind === 'agent' && !form.userInput.trim())
              }
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
        <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
          <button
            className="btn-new-task"
            onClick={() => { setNlOpen(o => !o); setNlError(null) }}
            title="用一句话描述任务，AI 自动生成草稿"
          >
            🪄 AI 生成
          </button>
          <button className="btn-new-task" onClick={() => setTemplateModalOpen(true)} title="从模板快速创建">
            📋 模板
          </button>
          <button className="btn-new-task" onClick={handleNew}>+ 新建</button>
        </div>
      </div>

      {/* AI 自然语言输入面板 */}
      {nlOpen && (
        <div className="nl-panel">
          <p className="nl-tip">
            用一句话说出你的需求，例如：<em>每天早上 9 点提醒我喝水并写句鼓励的话</em>
          </p>
          <textarea
            className="form-textarea"
            rows={2}
            value={nlText}
            onChange={e => setNlText(e.target.value)}
            placeholder="每天 / 每周 / 每隔 N 分钟… 我希望…"
            disabled={nlParsing}
          />
          {nlError && <div className="nl-error">⚠ {nlError}</div>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 6 }}>
            <button
              className="btn-cancel"
              onClick={() => { setNlOpen(false); setNlText(''); setNlError(null) }}
              disabled={nlParsing}
            >
              取消
            </button>
            <button
              className="btn-save"
              onClick={handleParseNL}
              disabled={nlParsing || !nlText.trim()}
            >
              {nlParsing ? '解析中…' : '生成草稿 →'}
            </button>
          </div>
        </div>
      )}

      {tasks.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">📭</div>
          <p>暂无定时任务</p>
          <button className="btn-new-task-large" onClick={handleNew}>创建第一个任务</button>
        </div>
      ) : (
        <>
        <div className="task-list">
          {tasks.map(task => (
            <div key={task.id} className={`task-card ${task.enabled ? '' : 'disabled'}`}>
              <div className="task-header">
                <span className="task-status">{statusIcon(task.lastRunStatus)}</span>
                <span className="task-name">{task.name}</span>
                <span
                  className="task-kind-badge"
                  title={(task.kind ?? 'shell') === 'agent' ? 'Agent 任务' : 'Shell 命令'}
                  style={{ marginLeft: 6 }}
                >
                  {(task.kind ?? 'shell') === 'agent' ? '🤖' : '🖥️'}
                </span>
                <span className={`task-enable-badge ${task.enabled ? 'on' : 'off'}`}>
                  {task.enabled ? '运行中' : '已禁用'}
                </span>
              </div>

              <div className="task-info">
                {(task.kind ?? 'shell') === 'agent' ? (
                  <div className="task-command" title={task.agentTask?.userInput}>
                    <span className="info-label">任务：</span>
                    <code>{task.agentTask?.userInput ?? ''}</code>
                  </div>
                ) : (
                  <div className="task-command" title={task.command}>
                    <span className="info-label">命令：</span>
                    <code>{task.command}</code>
                  </div>
                )}
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
                {task.lastRunStatus === 'running' ? (
                  <button
                    className="btn-action btn-stop"
                    onClick={() => handleStop(task.id)}
                    title="立即终止正在运行的执行"
                  >
                    ⏹ 停止
                  </button>
                ) : (
                  <button className="btn-action btn-run" onClick={() => handleRun(task.id)} title="立即执行">
                    ▶ 执行
                  </button>
                )}
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
        </>
      )}

      {/* Agent 改任务时的浮动提示 */}
      {crudToast && <div className="crud-toast">{crudToast}</div>}

      {/* 模板选择弹层 */}
      {templateModalOpen && (
        <div className="template-modal-mask" onClick={() => setTemplateModalOpen(false)}>
          <div className="template-modal" onClick={e => e.stopPropagation()}>
            <h3>📋 选择任务模板</h3>
            <p>应用后可继续修改名称/时间/任务描述。模板均为 Agent 任务，触发后会自动匹配技能。</p>
            <div className="template-grid">
              {AGENT_CRON_TEMPLATES.map(tpl => (
                <button
                  key={tpl.id}
                  type="button"
                  className="template-card"
                  onClick={() => handleApplyTemplate(tpl)}
                >
                  <div className="template-icon">{tpl.icon}</div>
                  <div className="template-name">{tpl.name}</div>
                  <div className="template-desc">{tpl.description}</div>
                  <div className="template-schedule">{formatSchedule(tpl.schedule)}</div>
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
              <button className="btn-cancel" onClick={() => setTemplateModalOpen(false)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
