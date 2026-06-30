import { useCallback, useEffect, useState } from 'react'
import type { AgentCronTask, AgentCronTemplate, ScheduleType, TaskSchedule } from '@shared/types'
import {
  deleteAgentCron,
  listAgentCronTemplates,
  listAgentCrons,
  migrateScheduledTasksToAgentCrons,
  runAgentCronNow,
  saveAgentCron,
  toggleAgentCron,
  useOnSchedulerTasksChanged,
} from '../../hooks/useIPC'
import { confirm as modalConfirm } from '../../components/Modal/Modal'
import './AgentCronPage.css'

const WEEK_DAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

interface CronForm {
  id?: string
  name: string
  description: string
  goal: string
  context: string
  scheduleType: ScheduleType
  intervalMinutes: number
  time: string
  weekDay: number
  maxSteps: number
  timeoutMinutes: number
  enabled: boolean
}

const emptyForm: CronForm = {
  name: '',
  description: '',
  goal: '',
  context: '',
  scheduleType: 'daily',
  intervalMinutes: 90,
  time: '09:00',
  weekDay: 1,
  maxSteps: 20,
  timeoutMinutes: 10,
  enabled: true,
}

export default function AgentCronPage() {
  const [crons, setCrons] = useState<AgentCronTask[]>([])
  const [templates, setTemplates] = useState<AgentCronTemplate[]>([])
  const [form, setForm] = useState<CronForm | null>(null)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const [cronList, templateList] = await Promise.all([
      listAgentCrons(),
      listAgentCronTemplates(),
    ])
    setCrons(cronList)
    setTemplates(templateList)
  }, [])
  const handleTasksChanged = useCallback(() => {
    refresh().catch(() => {})
  }, [refresh])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      refresh().catch(() => {
        setCrons([])
        setTemplates([])
      })
    }, 0)
    return () => window.clearTimeout(timer)
  }, [refresh])
  useOnSchedulerTasksChanged(handleTasksChanged)

  const flash = (text: string) => {
    setToast(text)
    window.setTimeout(() => setToast(null), 2600)
  }

  const editCron = (cron: AgentCronTask) => {
    setForm({
      id: cron.id,
      name: cron.name,
      description: cron.description,
      goal: cron.agentTask.goal,
      context: cron.agentTask.context ?? '',
      scheduleType: cron.schedule.type,
      intervalMinutes: cron.schedule.intervalMinutes ?? 90,
      time: cron.schedule.time ?? '09:00',
      weekDay: cron.schedule.weekDay ?? 1,
      maxSteps: cron.agentTask.maxSteps,
      timeoutMinutes: cron.agentTask.timeoutMinutes,
      enabled: cron.enabled,
    })
  }

  const applyTemplate = (tpl: AgentCronTemplate) => {
    const t = tpl.template
    setForm({
      ...emptyForm,
      name: t.name,
      description: t.description,
      goal: t.agentTask.goal,
      context: t.agentTask.context ?? '',
      scheduleType: t.schedule.type,
      intervalMinutes: t.schedule.intervalMinutes ?? 90,
      time: t.schedule.time ?? '09:00',
      weekDay: t.schedule.weekDay ?? 1,
      maxSteps: t.agentTask.maxSteps,
      timeoutMinutes: t.agentTask.timeoutMinutes,
      enabled: t.enabled,
    })
  }

  const submitForm = async () => {
    if (!form?.name.trim() || !form.goal.trim()) return
    setBusy(true)
    const schedule = formToSchedule(form)
    const result = await saveAgentCron({
      ...(form.id && { id: form.id }),
      name: form.name.trim(),
      description: form.description.trim(),
      schedule,
      agentTask: {
        goal: form.goal.trim(),
        context: form.context.trim() || undefined,
        maxSteps: form.maxSteps,
        timeoutMinutes: form.timeoutMinutes,
      },
      notify: { onStart: false, onComplete: true, onError: true },
      enabled: form.enabled,
    })
    setBusy(false)
    if (!result.ok) {
      flash(`保存失败：${result.error ?? '未知错误'}`)
      return
    }
    setForm(null)
    await refresh()
    flash('已保存 Agent Cron')
  }

  const handleDelete = async (id: string) => {
    const ok = await modalConfirm('确定要删除这个 Agent Cron 吗？', '删除 Agent Cron', true)
    if (!ok) return
    await deleteAgentCron(id)
    await refresh()
    flash('已删除')
  }

  const handleToggle = async (id: string) => {
    await toggleAgentCron(id)
    await refresh()
  }

  const handleRun = async (id: string) => {
    const result = await runAgentCronNow(id)
    if (result.ok) flash('已启动执行')
    else flash(`执行失败：${result.error ?? '未知错误'}`)
    window.setTimeout(refresh, 700)
  }

  const handleMigrate = async (disableOriginal = false) => {
    const result = await migrateScheduledTasksToAgentCrons({ disableOriginal })
    if (!result.ok) {
      flash(`迁移失败：${result.error ?? '未知错误'}`)
      return
    }
    await refresh()
    flash(`迁移 ${result.migrated?.length ?? 0} 条，跳过 ${result.skipped?.length ?? 0} 条`)
  }

  return (
    <div className="agent-cron-page">
      <header className="agent-cron-header">
        <div>
          <h1>Agent Cron</h1>
          <p>定时启动 Agent 执行工作流</p>
        </div>
        <div className="agent-cron-actions">
          <button type="button" onClick={() => setForm({ ...emptyForm })}>新建</button>
          <button type="button" onClick={() => handleMigrate(false)}>仅迁移旧任务</button>
          <button type="button" onClick={() => handleMigrate(true)}>迁移并停用旧任务</button>
          <button type="button" onClick={refresh}>刷新</button>
        </div>
      </header>

      {toast && <div className="agent-cron-toast">{toast}</div>}

      <section className="agent-cron-template-strip">
        {templates.map(tpl => (
          <button key={tpl.id} type="button" onClick={() => applyTemplate(tpl)}>
            <span>{tpl.icon}</span>
            <strong>{tpl.name}</strong>
          </button>
        ))}
      </section>

      {form && (
        <section className="agent-cron-form">
          <div className="agent-cron-form-grid">
            <label>
              名称
              <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
            </label>
            <label>
              描述
              <input value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} />
            </label>
            <label className="wide">
              目标
              <textarea rows={3} value={form.goal} onChange={e => setForm({ ...form, goal: e.target.value })} />
            </label>
            <label className="wide">
              上下文
              <textarea rows={2} value={form.context} onChange={e => setForm({ ...form, context: e.target.value })} />
            </label>
            <label>
              调度
              <select value={form.scheduleType} onChange={e => setForm({ ...form, scheduleType: e.target.value as ScheduleType })}>
                <option value="interval">间隔</option>
                <option value="daily">每天</option>
                <option value="weekly">每周</option>
              </select>
            </label>
            {form.scheduleType === 'interval' ? (
              <label>
                间隔分钟
                <input
                  type="number"
                  min={1}
                  max={1440}
                  value={form.intervalMinutes}
                  onChange={e => setForm({ ...form, intervalMinutes: Number(e.target.value) })}
                />
              </label>
            ) : (
              <label>
                时间
                <input type="time" value={form.time} onChange={e => setForm({ ...form, time: e.target.value })} />
              </label>
            )}
            {form.scheduleType === 'weekly' && (
              <label>
                星期
                <select value={form.weekDay} onChange={e => setForm({ ...form, weekDay: Number(e.target.value) })}>
                  {WEEK_DAYS.map((day, index) => <option key={day} value={index}>{day}</option>)}
                </select>
              </label>
            )}
            <label>
              最大步数
              <input type="number" min={1} max={50} value={form.maxSteps} onChange={e => setForm({ ...form, maxSteps: Number(e.target.value) })} />
            </label>
            <label>
              超时分钟
              <input type="number" min={1} max={120} value={form.timeoutMinutes} onChange={e => setForm({ ...form, timeoutMinutes: Number(e.target.value) })} />
            </label>
            <label className="check-row">
              <input type="checkbox" checked={form.enabled} onChange={e => setForm({ ...form, enabled: e.target.checked })} />
              启用
            </label>
          </div>
          <div className="agent-cron-form-actions">
            <button type="button" onClick={submitForm} disabled={busy || !form.name.trim() || !form.goal.trim()}>
              {busy ? '保存中...' : '保存'}
            </button>
            <button type="button" onClick={() => setForm(null)}>取消</button>
          </div>
        </section>
      )}

      <main className="agent-cron-list">
        {crons.length === 0 ? (
          <div className="agent-cron-empty">暂无 Agent Cron</div>
        ) : crons.map(cron => (
          <article key={cron.id} className={`agent-cron-card ${cron.enabled ? '' : 'disabled'}`}>
            <div className="agent-cron-card-main">
              <div>
                <h2>{cron.name}</h2>
                <p>{cron.description || cron.agentTask.goal}</p>
              </div>
              <span>{formatSchedule(cron.schedule)}</span>
            </div>
            <pre>{cron.agentTask.goal}</pre>
            <footer>
              <span>{cron.enabled ? '已启用' : '已停用'} · {cron.lastRunStatus ?? '未执行'}</span>
              <div>
                <button type="button" onClick={() => handleRun(cron.id)}>立即执行</button>
                <button type="button" onClick={() => handleToggle(cron.id)}>{cron.enabled ? '停用' : '启用'}</button>
                <button type="button" onClick={() => editCron(cron)}>编辑</button>
                <button type="button" onClick={() => handleDelete(cron.id)}>删除</button>
              </div>
            </footer>
          </article>
        ))}
      </main>
    </div>
  )
}

function formToSchedule(form: CronForm): TaskSchedule {
  if (form.scheduleType === 'interval') {
    return { type: 'interval', intervalMinutes: clampInt(form.intervalMinutes, 1, 1440) }
  }
  if (form.scheduleType === 'weekly') {
    return { type: 'weekly', time: form.time || '09:00', weekDay: clampInt(form.weekDay, 0, 6) }
  }
  return { type: 'daily', time: form.time || '09:00' }
}

function formatSchedule(schedule: TaskSchedule): string {
  if (schedule.type === 'interval') return `每 ${schedule.intervalMinutes ?? 90} 分钟`
  if (schedule.type === 'weekly') return `每${WEEK_DAYS[schedule.weekDay ?? 1]} ${schedule.time ?? '09:00'}`
  return `每天 ${schedule.time ?? '09:00'}`
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, Math.floor(value)))
}
