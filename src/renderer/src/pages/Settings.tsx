/**
 * 设置页面
 * 在独立窗口中打开
 */

import { useState, useEffect, useLayoutEffect } from 'react'
import type { AppConfig } from '@shared/types'
import { IPC } from '@shared/ipc-channels'
import './Settings.css'

// 在设置窗口中，electronAPI 可能挂在 window 上
const api = (window as any).electronAPI

export default function Settings() {
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [testResult, setTestResult] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // 设置页面在独立窗口中打开，覆盖 App.css 的 body overflow:hidden
  useLayoutEffect(() => {
    document.body.style.overflow = 'auto'
    document.body.style.background = '#fffef5'
    return () => { document.body.style.overflow = '' }
  }, [])

  useEffect(() => {
    api.invoke('renderer:config-get').then((c: AppConfig) => setConfig(c))
    api.invoke('renderer:apikey-get').then((k: string) => setApiKey(k ?? ''))
  }, [])

  if (!config) return <div className="settings-loading">加载中...</div>

  const update = (patch: Partial<AppConfig>) => {
    setConfig(prev => prev ? { ...prev, ...patch } : prev)
  }

  const handleSave = async () => {
    // 导出目录前置校验：开启了导出但目录为空
    if (config.summary_export_docx && !config.summary_export_dir.trim()) {
      setTestResult('❌ 请先选择 Word 导出目录')
      return
    }
    setSaving(true)
    await api.invoke('renderer:config-set', config)
    // 始终保存 API Key（包括空字符串，允许用户清空）
    await api.invoke('renderer:apikey-set', apiKey)
    setSaving(false)
    setTestResult('✅ 设置已保存')
    setTimeout(() => setTestResult(null), 2000)
  }

  const handleTestAPI = async () => {
    setTestResult('测试中...')
    const result = await api.invoke('renderer:api-test', {
      url: config.llm_api_url,
      key: apiKey,
      model: config.llm_model,
    })
    if (result.ok) {
      setTestResult('✅ 连接成功')
    } else {
      setTestResult(`❌ 连接失败：${result.error}`)
    }
  }

  return (
    <div className="settings-container">
      <h1 className="settings-title">⚙ 小小牛马 设置</h1>

      <section className="settings-section">
        <h2>工作时间</h2>
        <div className="field-row">
          <label>上班时间</label>
          <input
            type="time"
            value={config.work_start}
            onChange={e => update({ work_start: e.target.value })}
          />
        </div>
        <div className="field-row">
          <label>下班时间</label>
          <input
            type="time"
            value={config.work_end}
            onChange={e => update({ work_end: e.target.value })}
          />
        </div>
      </section>

      <section className="settings-section">
        <h2>休息提醒</h2>
        <div className="field-row">
          <label>连续工作提醒（分钟）</label>
          <input
            type="number"
            min={5}
            max={120}
            value={config.focus_threshold_min}
            onChange={e => update({ focus_threshold_min: Number(e.target.value) })}
          />
        </div>
        <div className="field-row">
          <label>离开重置阈值（分钟）</label>
          <input
            type="number"
            min={1}
            max={30}
            value={config.away_threshold_min}
            onChange={e => update({ away_threshold_min: Number(e.target.value) })}
          />
        </div>
        <div className="field-row">
          <label>「再等一会儿」延迟（分钟）</label>
          <input
            type="number"
            min={1}
            max={60}
            value={config.snooze_min}
            onChange={e => update({ snooze_min: Number(e.target.value) })}
          />
        </div>
      </section>

      <section className="settings-section">
        <h2>AI 模型配置</h2>
        <div className="field-row">
          <label>API 地址</label>
          <input
            type="text"
            value={config.llm_api_url}
            onChange={e => update({ llm_api_url: e.target.value })}
            placeholder="https://api.openai.com/v1"
          />
        </div>
        <div className="field-row">
          <label>API Key</label>
          <div style={{ flex: 1, maxWidth: 240, display: 'flex', flexDirection: 'column', gap: 2 }}>
            <input
              type="password"
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder="sk-..."
              style={{ width: '100%' }}
            />
            {apiKey.length > 0 && (
              <span style={{ fontSize: 10, color: '#8b5e3c', opacity: 0.7 }}>
                已填写（{apiKey.length} 字符）· 清空后保存可删除
              </span>
            )}
          </div>
        </div>
        <div className="field-row">
          <label>模型名称</label>
          <input
            type="text"
            value={config.llm_model}
            onChange={e => update({ llm_model: e.target.value })}
            placeholder="gpt-4o"
          />
        </div>
        <button className="btn-test" onClick={handleTestAPI}>
          测试连接
        </button>
        {testResult && <div className="test-result">{testResult}</div>}
      </section>

      <section className="settings-section">
        <h2>AI 对话</h2>
        <div className="field-row">
          <label>唤出快捷键</label>
          <input
            type="text"
            value={config.ai_chat_hotkey}
            onChange={e => update({ ai_chat_hotkey: e.target.value })}
            placeholder="CommandOrControl+Shift+A"
          />
        </div>
        <div className="field-row" style={{ alignItems: 'flex-start' }}>
          <label>系统提示词（可选）</label>
          <textarea
            value={config.ai_chat_system_prompt}
            onChange={e => update({ ai_chat_system_prompt: e.target.value })}
            placeholder="你是一个乐于助人的 AI 助手…"
            rows={3}
            style={{ flex: 1, maxWidth: 240, resize: 'vertical', fontFamily: 'inherit', fontSize: 12, padding: 6 }}
          />
        </div>
      </section>

      <section className="settings-section">
        <h2>导出设置</h2>
        <div className="field-row">
          <label>导出工作总结为 Word</label>
          <input
            type="checkbox"
            checked={config.summary_export_docx}
            onChange={e => update({ summary_export_docx: e.target.checked })}
          />
        </div>
        {config.summary_export_docx && (
          <div className="field-row">
            <label>导出目录</label>
            <div className="dir-picker">
              <input
                type="text"
                value={config.summary_export_dir}
                onChange={e => update({ summary_export_dir: e.target.value })}
                placeholder="点击选择目录..."
                readOnly
              />
              <button
                className="btn-test"
                onClick={async () => {
                  const dir = await api.invoke('renderer:select-directory') as string
                  if (dir) update({ summary_export_dir: dir })
                }}
              >
                选择
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="settings-section">
        <h2>数据备份</h2>
        <div className="field-row" style={{ alignItems: 'flex-start' }}>
          <label style={{ paddingTop: 4 }}>导出/恢复</label>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 240 }}>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button
                className="btn-test"
                onClick={async () => {
                  const r = await api.invoke(IPC.BACKUP_EXPORT) as { ok: boolean; filePath?: string; reason?: string }
                  if (r.ok) setTestResult(`✓ 已导出到：${r.filePath}`)
                  else if (r.reason !== 'cancelled') setTestResult(`✗ 导出失败：${r.reason}`)
                }}
              >⬇ 导出全部数据</button>
              <button
                className="btn-test"
                onClick={async () => {
                  const r = await api.invoke(IPC.BACKUP_IMPORT) as { ok: boolean; reason?: string; snapshotDir?: string }
                  if (r.ok) setTestResult(`✓ 恢复成功，原数据已备份到：${r.snapshotDir}（请重启应用生效）`)
                  else if (r.reason !== 'cancelled' && r.reason !== 'cancelled-by-user') setTestResult(`✗ 恢复失败：${r.reason}`)
                }}
              >⬆ 从备份恢复</button>
              <button
                className="btn-test"
                onClick={async () => {
                  await api.invoke(IPC.BACKUP_OPEN_DATA_DIR)
                }}
              >📂 打开数据目录</button>
            </div>
            <small style={{ fontSize: 11, color: '#8a7e5e', lineHeight: 1.5 }}>
              备份包含：日志、待办、AI 对话、定时任务、应用配置。<br />
              不包含：API Key（保存在系统钥匙串）、应用日志文件。
            </small>
          </div>
        </div>
      </section>

      <section className="settings-section">
        <h2>系统</h2>
        <div className="field-row">
          <label>开机自启动</label>
          <input
            type="checkbox"
            checked={config.auto_launch}
            onChange={e => update({ auto_launch: e.target.checked })}
          />
        </div>
      </section>

      <div className="settings-footer">
        <button className="btn-save" onClick={handleSave} disabled={saving}>
          {saving ? '保存中...' : '保存设置'}
        </button>
      </div>
    </div>
  )
}
