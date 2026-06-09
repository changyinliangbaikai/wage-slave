/**
 * 技能中心页面（Phase 2）
 *
 * 独立窗口，路由 #/skills。两个 Tab：
 *  - 已安装：管理/启停/卸载内置与用户技能，支持搜索、从文件/zip/URL 安装
 *  - 发现：浏览市场技能并一键安装（远程不可用时展示本地精选）
 */

import { useEffect, useMemo, useState } from 'react'
import type { SkillConfig, SkillWithState } from '@shared/types'
import { useSkills } from '../hooks/useSkills'
import { SkillManager } from './agent/SkillManager'
import { SkillMarket } from './agent/SkillMarket'
import './SkillsPage.css'

type Tab = 'installed' | 'market'
type Toast = { type: 'ok' | 'err'; text: string }

export default function SkillsPage() {
  const {
    installed,
    market,
    installedIds,
    loading,
    marketLoading,
    loadMarket,
    search,
    toggle,
    updateConfig,
    installFromFile,
    installFromUrl,
    installFromMarket,
    uninstall,
  } = useSkills()

  const [tab, setTab] = useState<Tab>('installed')
  const [query, setQuery] = useState('')
  const [showUrlInput, setShowUrlInput] = useState(false)
  const [url, setUrl] = useState('')
  const [toast, setToast] = useState<Toast | null>(null)

  // 切到市场 Tab 时按需加载市场列表
  useEffect(() => {
    if (tab === 'market' && market.length === 0) loadMarket()
  }, [tab, market.length, loadMarket])

  // toast 自动消失
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 2600)
    return () => clearTimeout(t)
  }, [toast])

  const showToast = (type: Toast['type'], text: string) => setToast({ type, text })

  const handleSearch = (v: string) => {
    setQuery(v)
    search(v)
  }

  const handleInstallFile = async () => {
    const res = await installFromFile()
    if (res.ok) showToast('ok', '已从文件安装技能')
    else if (res.error) showToast('err', `安装失败：${res.error}`)
  }

  const handleInstallUrl = async () => {
    const u = url.trim()
    if (!u) return
    const res = await installFromUrl(u)
    if (res.ok) {
      showToast('ok', '已从 URL 安装技能')
      setUrl('')
      setShowUrlInput(false)
    } else {
      showToast('err', `安装失败：${res.error ?? '未知错误'}`)
    }
  }

  const handleInstallMarket = async (id: string) => {
    const res = await installFromMarket(id)
    if (res.ok) showToast('ok', '已安装到本地')
    else showToast('err', `安装失败：${res.error ?? '未知错误'}`)
  }

  const handleUninstall = async (s: SkillWithState) => {
    if (s.scope === 'builtin') {
      showToast('err', '内置技能不可卸载，可停用')
      return
    }
    await uninstall(s.id)
    showToast('ok', '已卸载技能')
  }

  const handleUpdateConfig = async (s: SkillWithState, config: SkillConfig) => {
    const res = await updateConfig(s.id, config)
    if (res.ok) showToast('ok', '已保存技能配置')
    else showToast('err', `保存失败：${res.error ?? '未知错误'}`)
    return res
  }

  const enabledCount = useMemo(() => installed.filter(s => s.enabled).length, [installed])

  return (
    <div className="skills-page">
      <header className="skills-header">
        <div className="skills-header__title">
          <span className="skills-header__emoji">🧩</span>
          <span>技能中心</span>
        </div>
        <div className="skills-tabs">
          <button
            type="button"
            className={`skills-tab ${tab === 'installed' ? 'is-active' : ''}`}
            onClick={() => setTab('installed')}
          >
            已安装
            {installed.length > 0 && (
              <em>
                {enabledCount}/{installed.length}
              </em>
            )}
          </button>
          <button
            type="button"
            className={`skills-tab ${tab === 'market' ? 'is-active' : ''}`}
            onClick={() => setTab('market')}
          >
            发现
          </button>
        </div>
      </header>

      {toast && <div className={`skills-toast skills-toast--${toast.type}`}>{toast.text}</div>}

      {tab === 'installed' ? (
        <SkillManager
          skills={installed}
          loading={loading}
          query={query}
          showUrlInput={showUrlInput}
          url={url}
          onQueryChange={handleSearch}
          onInstallFile={handleInstallFile}
          onToggleUrlInput={() => setShowUrlInput(v => !v)}
          onUrlChange={setUrl}
          onInstallUrl={handleInstallUrl}
          onToggleSkill={toggle}
          onUpdateSkillConfig={handleUpdateConfig}
          onUninstallSkill={handleUninstall}
        />
      ) : (
        <SkillMarket
          skills={market}
          installedIds={installedIds}
          loading={marketLoading}
          onRefresh={loadMarket}
          onInstall={handleInstallMarket}
        />
      )}
    </div>
  )
}
