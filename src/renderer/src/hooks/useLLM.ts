/**
 * LLM 调用 Hook
 * 通过 IPC 调用主进程执行 API 请求（绕过渲染进程 CORS 限制）
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import { IPC } from '@shared/ipc-channels'
import type { TodoItem, DailyLog } from '@shared/types'

const api = window.electronAPI

// ── Hook: 计划解析 ─────────────────────────────
export function useParsePlan() {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const parse = useCallback(async (input: string): Promise<TodoItem[]> => {
    if (!input.trim()) return []
    setLoading(true)
    setError(null)

    try {
      const result = await api.invoke(IPC.LLM_PARSE_PLAN, input) as {
        todos: TodoItem[]
        error?: string
      }

      if (result.error) {
        setError(result.error)
      }

      return result.todos
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      return []
    } finally {
      setLoading(false)
    }
  }, [])

  return { parse, loading, error }
}

// ── Hook: 总结生成（流式） ──────────────────────
export function useGenerateSummary() {
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState('')
  const [error, setError] = useState<string | null>(null)
  const cleanupRef = useRef<(() => void) | null>(null)

  // 清理流式监听
  useEffect(() => {
    return () => { cleanupRef.current?.() }
  }, [])

  const generate = useCallback(async (logs: DailyLog[], periodLabel: string) => {
    setLoading(true)
    setResult('')
    setError(null)

    // 监听流式推送
    cleanupRef.current?.()
    cleanupRef.current = api.on(IPC.LLM_SUMMARY_STREAM, (accumulated: unknown) => {
      setResult(accumulated as string)
    })

    try {
      const res = await api.invoke(IPC.LLM_SUMMARY, { logs, periodLabel }) as {
        result: string
        error?: string
      }

      if (res.error) {
        setError(res.error)
      }
      if (res.result) {
        setResult(res.result) // 最终完整结果
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
    } finally {
      setLoading(false)
      cleanupRef.current?.()
      cleanupRef.current = null
    }
  }, [])

  return { generate, loading, result, error }
}
