/**
 * Skill 管理 Hook（Phase 2）
 *
 * 职责：
 *  - 维护"已安装技能"与"市场技能"两份列表
 *  - 封装启停 / 安装（本地·URL·市场）/ 卸载操作
 *  - 监听主进程 SKILL_CHANGED 事件自动刷新
 */

import { useCallback, useEffect, useState } from 'react'
import { IPC } from '@shared/ipc-channels'
import type { SkillConfig, SkillWithState, MarketSkillItem } from '@shared/types'
import {
  listSkills,
  searchSkills as ipcSearchSkills,
  toggleSkill as ipcToggleSkill,
  updateSkillConfig as ipcUpdateSkillConfig,
  installSkillFromFile,
  installSkillFromUrl,
  installSkillFromMarket,
  uninstallSkill,
  fetchMarketSkills,
  useOnEvent,
} from './useIPC'

export function useSkills() {
  const [installed, setInstalled] = useState<SkillWithState[]>([])
  const [market, setMarket] = useState<MarketSkillItem[]>([])
  const [loading, setLoading] = useState(false)
  const [marketLoading, setMarketLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 刷新已安装列表
  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const list = await listSkills()
      setInstalled(list)
      console.log('[useSkills] 已加载技能数:', list.length)
    } catch (e) {
      console.error('[useSkills] 加载技能失败:', e)
      setError(e instanceof Error ? e.message : '加载技能失败')
    } finally {
      setLoading(false)
    }
  }, [])

  // 拉取市场列表
  const loadMarket = useCallback(async () => {
    setMarketLoading(true)
    try {
      const res = await fetchMarketSkills()
      setMarket(res.skills ?? [])
      console.log('[useSkills] 市场技能数:', res.skills?.length ?? 0)
    } catch (e) {
      console.error('[useSkills] 加载市场失败:', e)
    } finally {
      setMarketLoading(false)
    }
  }, [])

  // 搜索（空串则回到全量）
  const search = useCallback(async (query: string) => {
    setLoading(true)
    try {
      const list = await ipcSearchSkills(query)
      setInstalled(list)
    } finally {
      setLoading(false)
    }
  }, [])

  // 启停
  const toggle = useCallback(async (id: string, enabled?: boolean) => {
    await ipcToggleSkill(id, enabled)
    await refresh()
  }, [refresh])

  const updateConfig = useCallback(async (id: string, config: SkillConfig): Promise<{ ok: boolean; error?: string }> => {
    const res = await ipcUpdateSkillConfig(id, config)
    if (res.ok) await refresh()
    return { ok: res.ok, error: res.error }
  }, [refresh])

  // 从本地文件安装
  const installFromFile = useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
    const res = await installSkillFromFile()
    if (res.ok) await refresh()
    return { ok: res.ok, error: res.error }
  }, [refresh])

  // 从 URL 安装
  const installFromUrl = useCallback(async (url: string): Promise<{ ok: boolean; error?: string }> => {
    const res = await installSkillFromUrl(url)
    if (res.ok) await refresh()
    return { ok: res.ok, error: res.error }
  }, [refresh])

  // 从市场安装
  const installFromMarket = useCallback(async (id: string): Promise<{ ok: boolean; error?: string }> => {
    const res = await installSkillFromMarket(id)
    if (res.ok) await refresh()
    return { ok: res.ok, error: res.error }
  }, [refresh])

  // 卸载
  const uninstall = useCallback(async (id: string) => {
    await uninstallSkill(id)
    await refresh()
  }, [refresh])

  // 初次加载
  useEffect(() => {
    refresh()
  }, [refresh])

  // 监听主进程通知，自动刷新
  useOnEvent(IPC.SKILL_CHANGED, () => {
    refresh()
  })

  // 已安装 id 集合（市场判断"是否已安装"用）
  const installedIds = new Set(installed.map(s => s.id))

  return {
    installed,
    market,
    installedIds,
    loading,
    marketLoading,
    error,
    refresh,
    loadMarket,
    search,
    toggle,
    updateConfig,
    installFromFile,
    installFromUrl,
    installFromMarket,
    uninstall,
  }
}
