/**
 * 错别字检查工具面板
 */

import { useState, useCallback } from 'react'
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

  // 开始检查
  const handleCheck = useCallback(async () => {
    if (!text.trim()) return

    setStatus('checking')
    setErrors([])
    setErrorMsg('')

    try {
      const result = await window.electronAPI.invoke(IPC.TOOLS_SPELL_CHECK, {
        text,
        stream: false,
      }) as {
        errors: SpellCheckError[]
        error?: string
      }

      if (result.error) {
        setErrorMsg(result.error)
        setStatus('error')
        return
      }

      // Calibrate LLM positions against actual text
      const calibrated = calibrateErrors(text, result.errors || [])
      setErrors(calibrated)
      setStatus('done')
    } catch (e) {
      setErrorMsg('检查失败，请重试')
      setStatus('error')
    }
  }, [text])

  // 重置
  const handleReset = useCallback(() => {
    setText('')
    setFileName('')
    setErrors([])
    setErrorMsg('')
    setStatus('idle')
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
        {(status === 'done' || status === 'error') && (
          <button className="btn-reset" onClick={handleReset}>
            重新开始
          </button>
        )}
      </div>

      {/* 错误信息 */}
      {status === 'error' && errorMsg && (
        <div className="error-message">
          ❌ {errorMsg}
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
