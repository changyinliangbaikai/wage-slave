/**
 * 工作总结生成流程
 * 支持选择时间范围（本周/本月/本季度/自定义），调用 LLM 生成总结
 */

import { useState, useCallback, useEffect } from 'react'
import SpeechBubble from '../components/SpeechBubble'
import { useGenerateSummary } from '../hooks/useLLM'
import { getLogsRange, getConfig, exportSummaryDocx } from '../hooks/useIPC'
import type { AppConfig, DailyLog } from '@shared/types'

interface Props {
  onDone: () => void
}

type Step = 'select-range' | 'loading-logs' | 'generating' | 'result' | 'no-data'
type RangePreset = 'week' | 'month' | 'quarter'

function localDateStr(d: Date = new Date()): string {
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** 计算时间范围 */
function getDateRange(preset: RangePreset): { start: string; end: string; label: string } {
  const now = new Date()
  const end = localDateStr(now)

  if (preset === 'week') {
    const d = new Date(now)
    const day = d.getDay()
    d.setDate(d.getDate() - (day === 0 ? 6 : day - 1)) // 回到本周一
    return { start: localDateStr(d), end, label: '本周' }
  }

  if (preset === 'month') {
    const start = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
    return { start, end, label: `${now.getMonth() + 1}月` }
  }

  // quarter
  const q = Math.floor(now.getMonth() / 3)
  const qStart = new Date(now.getFullYear(), q * 3, 1)
  const start = localDateStr(qStart)
  const qNames = ['Q1', 'Q2', 'Q3', 'Q4']
  return { start, end, label: `${now.getFullYear()} ${qNames[q]}` }
}

export default function SummaryFlow({ onDone }: Props) {
  const [step, setStep] = useState<Step>('select-range')
  const { generate, loading, result, error } = useGenerateSummary()
  const [config, setAppConfig] = useState<AppConfig | null>(null)
  const [exportMsg, setExportMsg] = useState<string | null>(null)
  const [currentLabel, setCurrentLabel] = useState('')

  useEffect(() => {
    getConfig().then(c => setAppConfig(c))
  }, [])

  const handleExportDocx = useCallback(async () => {
    if (!result) return
    setExportMsg('正在导出...')
    const res = await exportSummaryDocx(result, currentLabel)
    if (res.ok) {
      setExportMsg(`✅ 已导出到 ${res.filePath}`)
    } else {
      setExportMsg(`❌ 导出失败：${res.error}`)
    }
    setTimeout(() => setExportMsg(null), 4000)
  }, [result, currentLabel])

  const handleSelectRange = useCallback(async (preset: RangePreset) => {
    const { start, end, label } = getDateRange(preset)
    setCurrentLabel(label)

    setStep('loading-logs')
    const logs: DailyLog[] = await getLogsRange(start, end)

    if (logs.length === 0) {
      setStep('no-data')
      return
    }

    setStep('generating')
    await generate(logs, label)
    setStep('result')
  }, [generate])

  if (step === 'select-range') {
    return (
      <SpeechBubble
        visible
        message="要生成哪个时间段的工作总结？"
        onClose={onDone}
      >
        <div className="bubble-actions" style={{ flexDirection: 'column', gap: '6px' }}>
          <button className="btn-primary" onClick={() => handleSelectRange('week')}>
            本周总结
          </button>
          <button className="btn-secondary" onClick={() => handleSelectRange('month')}>
            本月总结
          </button>
          <button className="btn-secondary" onClick={() => handleSelectRange('quarter')}>
            本季度总结
          </button>
        </div>
      </SpeechBubble>
    )
  }

  if (step === 'loading-logs') {
    return (
      <SpeechBubble
        visible
        message="正在读取工作日志..."
      />
    )
  }

  if (step === 'generating') {
    return (
      <SpeechBubble
        visible
        message={loading ? '正在生成总结，请稍等...' : '生成完成！'}
      >
        {result && (
          <div className="summary-preview">
            <pre className="summary-text">{result}</pre>
          </div>
        )}
        {!loading && (
          <div className="bubble-actions">
            <button className="btn-secondary" onClick={() => setStep('select-range')}>
              换个范围
            </button>
            {config?.summary_export_docx && config?.summary_export_dir && (
              <button className="btn-secondary" onClick={handleExportDocx}>
                导出 Word
              </button>
            )}
            <button className="btn-primary" onClick={() => {
              // 复制到剪贴板
              navigator.clipboard.writeText(result).catch(() => {})
              onDone()
            }}>
              复制并关闭
            </button>
          </div>
        )}
      </SpeechBubble>
    )
  }

  if (step === 'result') {
    const canExport = config?.summary_export_docx && config?.summary_export_dir
    return (
      <SpeechBubble
        visible
        message="总结已生成！"
        onClose={onDone}
      >
        <div className="summary-preview">
          <pre className="summary-text">{result}</pre>
        </div>
        {error && <div className="summary-error">{error}</div>}
        {exportMsg && <div className="export-msg">{exportMsg}</div>}
        <div className="bubble-actions">
          <button className="btn-secondary" onClick={() => setStep('select-range')}>
            换个范围
          </button>
          {canExport && (
            <button className="btn-secondary" onClick={handleExportDocx}>
              导出 Word
            </button>
          )}
          <button className="btn-primary" onClick={() => {
            navigator.clipboard.writeText(result).catch(() => {})
            onDone()
          }}>
            复制并关闭
          </button>
        </div>
      </SpeechBubble>
    )
  }

  if (step === 'no-data') {
    return (
      <SpeechBubble
        visible
        message="这段时间还没有工作日志哦～\n先去录入一些再来生成总结吧 🐾"
        onClose={onDone}
      >
        <div className="bubble-actions">
          <button className="btn-primary" onClick={onDone}>知道了</button>
        </div>
      </SpeechBubble>
    )
  }

  return null
}
