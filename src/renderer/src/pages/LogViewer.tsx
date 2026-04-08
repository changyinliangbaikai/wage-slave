/**
 * 工作日志查看器
 * 在独立窗口中展示，支持按日期浏览
 */

import { useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react'
import type { DailyLog } from '@shared/types'
import './LogViewer.css'

const api = (window as any).electronAPI

/** 日期格式化辅助 */
function formatWeekday(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00')
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()]
}

/** 将 ISO UTC 时间字符串转换为本地时间显示（YYYY-MM-DD HH:mm） */
function formatTimestamp(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const y = d.getFullYear()
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const h = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${y}-${mo}-${day} ${h}:${mi}`
}

/** 用本地时间生成 YYYY-MM-DD，避免 toISOString 的 UTC 时区偏移 */
function localDateStr(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function todayStr(): string {
  return localDateStr(new Date())
}

/** 获取日期偏移 */
function shiftDate(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T12:00:00') // 用正午避免夏令时边界问题
  d.setDate(d.getDate() + days)
  return localDateStr(d)
}

export default function LogViewer() {
  const [date, setDate] = useState(todayStr())
  const [log, setLog] = useState<DailyLog | null>(null)
  const [loading, setLoading] = useState(false)
  const [copyTip, setCopyTip] = useState('')
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 一键复制文本到剪贴板，2 秒后自动清除提示
  const handleCopy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      console.log('[LogViewer] Copied to clipboard, length:', text.length)
      setCopyTip('已复制')
    } catch {
      setCopyTip('复制失败')
    } finally {
      if (copyTimer.current) clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopyTip(''), 2000)
    }
  }, [])

  // 覆盖 App.css 的 body overflow:hidden
  useLayoutEffect(() => {
    document.body.style.overflow = 'auto'
    document.body.style.background = '#fffef5'
    return () => { document.body.style.overflow = '' }
  }, [])

  useEffect(() => {
    setLoading(true)
    api.invoke('renderer:log-get', date).then((l: DailyLog | null) => {
      setLog(l)
      setLoading(false)
    })
  }, [date])

  const isToday = date === todayStr()

  return (
    <div className="log-viewer">
      <h1 className="log-title">📒 工作日志</h1>

      {/* 日期导航 */}
      <div className="log-date-nav">
        <button className="nav-btn" onClick={() => setDate(shiftDate(date, -1))}>◀ 前一天</button>
        <div className="nav-center">
          <input
            type="date"
            value={date}
            max={todayStr()}
            onChange={e => setDate(e.target.value)}
          />
          <span className="nav-weekday">{formatWeekday(date)}</span>
        </div>
        <button
          className="nav-btn"
          onClick={() => setDate(shiftDate(date, 1))}
          disabled={isToday}
        >
          后一天 ▶
        </button>
      </div>

      {/* 日志内容 */}
      {loading ? (
        <div className="log-empty">加载中...</div>
      ) : !log ? (
        <div className="log-empty">这一天没有记录 📭</div>
      ) : (
        <div className="log-content">
          {/* 计划原文 */}
          {log.plan_input && (
            <section className="log-section">
              <h2>
                原始计划
                <button
                  className="copy-btn"
                  onClick={() => handleCopy(log.plan_input)}
                  title="复制原始计划"
                >
                  {copyTip || '复制'}
                </button>
              </h2>
              <p className="log-text log-text-selectable">{log.plan_input}</p>
            </section>
          )}

          {/* 待办清单 */}
          {log.todos && log.todos.length > 0 && (
            <section className="log-section">
              <h2>
                待办清单
                <span className="log-stat">
                  {log.todos.filter(t => t.status === 'done').length}/{log.todos.length} 完成
                </span>
              </h2>
              <ul className="log-todo-list">
                {log.todos.map(t => (
                  <li key={t.id} className={`log-todo ${t.status}`}>
                    <span className="log-todo-check">{t.status === 'done' ? '✓' : '○'}</span>
                    <span className="log-todo-title">{t.title}</span>
                    {t.priority === 'high' && <span className="log-tag-high">紧急</span>}
                    {t.estimated_min && (
                      <span className="log-tag-time">{t.estimated_min}min</span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* 工作日志 */}
          {log.eod_log && (
            <section className="log-section">
              <h2>工作日志</h2>
              <p className="log-text">{log.eod_log}</p>
            </section>
          )}

          {/* 跳过状态 */}
          {log.morning_skipped && !log.plan_input && (
            <div className="log-note">这天跳过了晨间计划录入</div>
          )}

          {/* 时间戳 */}
          <div className="log-timestamps">
            <span>创建：{formatTimestamp(log.created_at)}</span>
            {log.updated_at && log.updated_at !== log.created_at && (
              <span>更新：{formatTimestamp(log.updated_at)}</span>
            )}
          </div>
        </div>
      )}

      {/* 快捷跳转 */}
      <div className="log-footer">
        <button
          className="nav-btn"
          onClick={() => setDate(todayStr())}
          disabled={isToday}
        >
          回到今天
        </button>
      </div>
    </div>
  )
}
