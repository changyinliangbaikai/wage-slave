/**
 * 错别字检查工具面板
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import { IPC } from '@shared/ipc-channels'
import type { SpellCheckError } from '@shared/types'
import './SpellCheckPanel.css'

interface Props {
  onBack: () => void
}

type InputMode = 'text' | 'file'
type CheckStatus = 'idle' | 'checking' | 'done' | 'error'

/**
 * Calibrate error positions by searching for err.original in the actual text.
 * LLM-returned start/end indices are often inaccurate, so we re-locate each
 * error by searching in the source text, preferring positions near the hint.
 */
function calibrateErrors(
  srcText: string,
  rawErrors: SpellCheckError[],
): SpellCheckError[] {
  const used = new Set<number>() // Track used positions to avoid duplicates
  return rawErrors.map((err) => {
    const original = err.original
    if (!original) return err

    // 1) Check if LLM position is accurate
    if (
      err.start >= 0 &&
      err.end <= srcText.length &&
      srcText.slice(err.start, err.start + original.length) === original &&
      !used.has(err.start)
    ) {
      used.add(err.start)
      return { ...err, end: err.start + original.length }
    }

    // 2) Search near the hinted position (±100 chars)
    const searchStart = Math.max(0, err.start - 100)
    const searchEnd = Math.min(srcText.length, err.start + 100)
    const region = srcText.slice(searchStart, searchEnd)
    let localIdx = -1
    let searchFrom = 0
    while (true) {
      const idx = region.indexOf(original, searchFrom)
      if (idx === -1) break
      const globalIdx = searchStart + idx
      if (!used.has(globalIdx)) {
        localIdx = idx
        break
      }
      searchFrom = idx + 1
    }
    if (localIdx !== -1) {
      const realStart = searchStart + localIdx
      used.add(realStart)
      return { ...err, start: realStart, end: realStart + original.length }
    }

    // 3) Global fallback search
    let globalFrom = 0
    while (true) {
      const idx = srcText.indexOf(original, globalFrom)
      if (idx === -1) break
      if (!used.has(idx)) {
        used.add(idx)
        return { ...err, start: idx, end: idx + original.length }
      }
      globalFrom = idx + 1
    }

    // 4) Cannot locate — mark as unfound
    return { ...err, start: -1, end: -1 }
  })
}

export default function SpellCheckPanel({ onBack }: Props) {
  const [inputMode, setInputMode] = useState<InputMode>('text')
  const [text, setText] = useState('')
  const [fileName, setFileName] = useState('')
  const [status, setStatus] = useState<CheckStatus>('idle')
  const [errors, setErrors] = useState<SpellCheckError[]>([])
  const [errorMsg, setErrorMsg] = useState('')
  // 流式进度信息：分别累计"思考过程"和"正文"字符数 + 总耗时
  const [reasoningChars, setReasoningChars] = useState(0)
  const [contentChars, setContentChars] = useState(0)
  const [elapsedSec, setElapsedSec] = useState(0)
  const startedAtRef = useRef<number>(0)
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // 订阅主进程推送的流式增量（reasoning_content 和 content 分通道展示）
  useEffect(() => {
    const off = window.electronAPI.on(IPC.TOOLS_SPELL_CHECK_CHUNK, (...args: unknown[]) => {
      const payload = (args[0] ?? {}) as { content?: string; reasoning?: string }
      setReasoningChars((payload.reasoning ?? '').length)
      setContentChars((payload.content ?? '').length)
    })
    return off
  }, [])

  // 卸载时清理计时器
  useEffect(() => {
    return () => {
      if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current)
    }
  }, [])

  // 打开文件选择对话框
  const handleOpenFile = useCallback(async () => {
    try {
      const result = await window.electronAPI.invoke(IPC.TOOLS_OPEN_FILE_DIALOG) as {
        ok: boolean
        canceled?: boolean
        filePath?: string
        error?: string
      }

      if (result.canceled || !result.filePath) return

      // 读取文件内容
      const fileResult = await window.electronAPI.invoke(IPC.TOOLS_READ_FILE, result.filePath) as {
        ok: boolean
        content?: string
        fileName?: string
        error?: string
      }

      if (!fileResult.ok) {
        setErrorMsg(fileResult.error || '读取文件失败')
        setStatus('error')
        return
      }

      setText(fileResult.content || '')
      setFileName(fileResult.fileName || '')
      setStatus('idle')
      setErrors([])
      setErrorMsg('')
    } catch (e) {
      setErrorMsg('打开文件失败')
      setStatus('error')
    }
  }, [])

  // 开始检查（流式）
  const handleCheck = useCallback(async () => {
    if (!text.trim()) return

    setStatus('checking')
    setErrors([])
    setErrorMsg('')
    setReasoningChars(0)
    setContentChars(0)
    setElapsedSec(0)
    startedAtRef.current = Date.now()

    // 启动 1s 心跳计时器，让用户看到检查仍在进行
    if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current)
    elapsedTimerRef.current = setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - startedAtRef.current) / 1000))
    }, 1000)

    try {
      const result = await window.electronAPI.invoke(IPC.TOOLS_SPELL_CHECK, {
        text,
        stream: true,
      }) as {
        errors: SpellCheckError[]
        error?: string
      }

      if (result.error) {
        setErrorMsg(result.error)
        setStatus(result.error === '已取消' ? 'idle' : 'error')
        return
      }

      // Calibrate LLM positions against actual text
      const calibrated = calibrateErrors(text, result.errors || [])
      setErrors(calibrated)
      setStatus('done')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setErrorMsg(`检查失败：${msg}`)
      setStatus('error')
    } finally {
      if (elapsedTimerRef.current) {
        clearInterval(elapsedTimerRef.current)
        elapsedTimerRef.current = null
      }
    }
  }, [text])

  // 取消正在进行的检查
  const handleCancel = useCallback(async () => {
    try {
      await window.electronAPI.invoke(IPC.TOOLS_SPELL_CHECK_CANCEL)
    } catch { /* 忽略 */ }
  }, [])

  // 打开应用运行日志文件夹
  // 失败时把原因写进 errorMsg，避免"点了没反应"无从排查
  const handleOpenLog = useCallback(async () => {
    console.log('[SpellCheckPanel] 点击查看运行日志')
    try {
      const result = await window.electronAPI.invoke(IPC.OPEN_LOG_FILE) as {
        ok: boolean
        path?: string
        error?: string
        hint?: string
      }
      console.log('[SpellCheckPanel] OPEN_LOG_FILE 结果:', result)
      if (!result?.ok) {
        const msg = result?.error || '打开日志失败（主进程可能未注册该 handler，请重启应用后重试）'
        setErrorMsg(msg)
        setStatus('error')
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error('[SpellCheckPanel] 调用 OPEN_LOG_FILE 异常:', msg)
      // 多半是 No handler registered，主进程未重启
      setErrorMsg(`打开日志失败：${msg}（请重启应用后重试）`)
      setStatus('error')
    }
  }, [])

  // 重置
  const handleReset = useCallback(() => {
    setText('')
    setFileName('')
    setErrors([])
    setErrorMsg('')
    setStatus('idle')
    setReasoningChars(0)
    setContentChars(0)
    setElapsedSec(0)
  }, [])

  return (
    <div className="spell-check-panel">
      <div className="panel-header">
        <button className="btn-back" onClick={onBack}>← 返回</button>
        <h3>✏️ 错别字检查</h3>
      </div>

      {/* 输入模式切换 */}
      <div className="input-mode-tabs">
        <button
          className={`tab ${inputMode === 'text' ? 'active' : ''}`}
          onClick={() => setInputMode('text')}
        >
          📝 直接输入
        </button>
        <button
          className={`tab ${inputMode === 'file' ? 'active' : ''}`}
          onClick={() => setInputMode('file')}
        >
          📂 打开文件
        </button>
      </div>

      {/* 文本输入 */}
      {inputMode === 'text' && (
        <div className="text-input-area">
          <textarea
            className="text-input"
            placeholder="请输入或粘贴需要检查的文字..."
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={status === 'checking'}
          />
        </div>
      )}

      {/* 文件输入 */}
      {inputMode === 'file' && (
        <div className="file-input-area">
          {fileName ? (
            <div className="file-info">
              <span className="file-name">📄 {fileName}</span>
              <button className="btn-change-file" onClick={handleOpenFile}>更换文件</button>
            </div>
          ) : (
            <button className="btn-open-file" onClick={handleOpenFile}>
              点击选择文件
            </button>
          )}
          {fileName && (
            <div className="text-input-area">
              <textarea
                className="text-input"
                placeholder="文件内容..."
                value={text}
                onChange={(e) => setText(e.target.value)}
                disabled={status === 'checking'}
              />
            </div>
          )}
        </div>
      )}

      {/* 操作按钮 */}
      <div className="action-buttons">
        <button
          className="btn-check"
          onClick={handleCheck}
          disabled={!text.trim() || status === 'checking'}
        >
          {status === 'checking' ? '检查中...' : '开始检查'}
        </button>
        {status === 'checking' && (
          <button className="btn-reset" onClick={handleCancel}>
            取消
          </button>
        )}
        {(status === 'done' || status === 'error') && (
          <button className="btn-reset" onClick={handleReset}>
            重新开始
          </button>
        )}
      </div>

      {/* 检查进度（流式） */}
      {/* 阶段判定：先 thinking（仅 reasoning 在累计） → 再 streaming（content 开始累计） */}
      {status === 'checking' && (() => {
        const phase = contentChars > 0
          ? 'streaming'
          : reasoningChars > 0
            ? 'thinking'
            : 'connecting'
        return (
          <div className="check-progress">
            <span className="dot-loader" aria-hidden="true">●●●</span>
            <span>
              {phase === 'connecting' && <>正在连接模型… 已耗时 <strong>{elapsedSec}s</strong></>}
              {phase === 'thinking' && (
                <>🧠 模型思考中… 已耗时 <strong>{elapsedSec}s</strong> · 已生成思考 <strong>{reasoningChars}</strong> 字符</>
              )}
              {phase === 'streaming' && (
                <>正在接收结果… 已耗时 <strong>{elapsedSec}s</strong> · 已接收 <strong>{contentChars}</strong> 字符
                  {reasoningChars > 0 && <> · 思考 {reasoningChars} 字</>}
                </>
              )}
            </span>
            <button className="btn-link" onClick={handleOpenLog} title="打开应用日志文件夹（main.log）">
              查看运行日志
            </button>
          </div>
        )
      })()}

      {/* 错误信息 */}
      {status === 'error' && errorMsg && (
        <div className="error-message">
          <div>❌ {errorMsg}</div>
          <button className="btn-link" onClick={handleOpenLog} title="打开应用日志文件夹（main.log）">
            查看运行日志
          </button>
        </div>
      )}

      {/* 检查结果 */}
      {status === 'done' && (
        <div className="result-area">
          {errors.length === 0 ? (
            <div className="no-errors">
              ✅ 没有发现错别字！
            </div>
          ) : (
            <>
              <div className="errors-summary">
                发现 <strong>{errors.length}</strong> 处错误
              </div>
              <div className="errors-list">
                {errors.map((err, idx) => {
                  // Check if position was successfully calibrated
                  const hasPosition = err.start >= 0 && err.end >= 0
                  const ctxStart = hasPosition ? Math.max(0, err.start - 15) : 0
                  const ctxEnd = hasPosition ? Math.min(text.length, err.end + 15) : 0
                  return (
                    <div key={idx} className="error-item">
                      {hasPosition && (
                        <div className="error-context">
                          {ctxStart > 0 && <span className="ctx-ellipsis">…</span>}
                          <span className="ctx-text">{text.slice(ctxStart, err.start)}</span>
                          <mark className="error-highlight">{err.original}</mark>
                          <span className="ctx-text">{text.slice(err.end, ctxEnd)}</span>
                          {ctxEnd < text.length && <span className="ctx-ellipsis">…</span>}
                        </div>
                      )}
                      <div className="error-detail">
                        <span className="error-original">「{err.original}」</span>
                        <span className="error-arrow"> → </span>
                        <span className="error-correction">「{err.correction}」</span>
                      </div>
                      {err.reason && (
                        <div className="error-reason">{err.reason}</div>
                      )}
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
