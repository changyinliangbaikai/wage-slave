/**
 * 技能中心页面（Phase 2）
 *
 * 独立窗口，路由 #/skills。两个 Tab：
 *  - 已安装：管理/启停/卸载内置与用户技能，支持搜索、从文件/URL 安装
 *  - 发现：浏览市场技能并一键安装（远程不可用时展示本地精选）
 */

import { useEffect, useMemo, useState } from 'react'
import type { SkillWithState, MarketSkillItem, SkillCategory, SkillScope } from '@shared/types'
import { useSkills } from '../hooks/useSkills'
import './SkillsPage.css'

/** 分类中文标签 */
const CATEGORY_LABEL: Record<SkillCategory, string> = {
  productivity: '生产力',
  file: '文件',
  code: '代码',
  writing: '写作',
  automation: '自动化',
  custom: '自定义',
}

/** 来源中文标签 */
const SCOPE_LABEL: Record<SkillScope, string> = {
  builtin: '内置',
  user: '自定义',
  remote: '远程',
}

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
        <>
          <div className="skills-toolbar">
            <input
              className="skills-search"
              placeholder="搜索技能（名称 / 描述 / 关键词）"
              value={query}
              onChange={e => handleSearch(e.target.value)}
            />
            <button type="button" className="skills-btn" onClick={handleInstallFile}>
              从文件安装
            </button>
            <button
              type="button"
              className="skills-btn"
              onClick={() => setShowUrlInput(v => !v)}
            >
              从 URL 安装
            </button>
          </div>

          {showUrlInput && (
            <div className="skills-url-row">
              <input
                placeholder="https://.../skill.json"
                value={url}
                onChange={e => setUrl(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') handleInstallUrl()
                }}
              />
              <button type="button" className="skills-btn skills-btn--primary" onClick={handleInstallUrl}>
                安装
              </button>
            </div>
          )}

          {loading ? (
            <div className="skills-loading">加载中…</div>
          ) : installed.length === 0 ? (
            <div className="skills-empty">没有匹配的技能</div>
          ) : (
            <div className="skills-list">
              {installed.map(s => (
                <InstalledCard
                  key={s.id}
                  skill={s}
                  onToggle={() => toggle(s.id)}
                  onUninstall={() => handleUninstall(s)}
                />
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="skills-toolbar">
            <span style={{ flex: 1, color: 'var(--sk-text-dim)', fontSize: 13 }}>
              发现并安装更多技能（远程不可用时展示精选）
            </span>
            <button type="button" className="skills-btn" onClick={loadMarket} disabled={marketLoading}>
              刷新
            </button>
          </div>

          {marketLoading ? (
            <div className="skills-loading">正在拉取市场…</div>
          ) : market.length === 0 ? (
            <div className="skills-empty">市场暂无可用技能</div>
          ) : (
            <div className="skills-list">
              {market.map(s => (
                <MarketCard
                  key={s.id}
                  skill={s}
                  installed={installedIds.has(s.id)}
                  onInstall={() => handleInstallMarket(s.id)}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** 已安装技能卡片 */
function InstalledCard({
  skill,
  onToggle,
  onUninstall,
}: {
  skill: SkillWithState
  onToggle: () => void
  onUninstall: () => void
}) {
  return (
    <div className={`skill-card ${skill.enabled ? '' : 'is-disabled'}`}>
      <div className="skill-card__head">
        <span className="skill-card__icon">{skill.icon}</span>
        <span className="skill-card__name">{skill.name}</span>
        <div className="skill-card__badges">
          <span className="skill-badge">{CATEGORY_LABEL[skill.category]}</span>
          <span className={`skill-badge skill-badge--${skill.scope}`}>{SCOPE_LABEL[skill.scope]}</span>
        </div>
      </div>

      <p className="skill-card__desc">{skill.description}</p>

      {skill.triggers.length > 0 && (
        <div className="skill-card__triggers">
          {skill.triggers.slice(0, 5).map(t => (
            <span key={t} className="skill-trigger">
              {t}
            </span>
          ))}
        </div>
      )}

      <div className="skill-card__foot">
        <button type="button" className="skill-switch" onClick={onToggle} aria-label="启用开关">
          <span className={`skill-switch__track ${skill.enabled ? 'is-on' : ''}`}>
            <span className="skill-switch__thumb" />
          </span>
          {skill.enabled ? '已启用' : '已停用'}
        </button>
        {skill.scope === 'builtin' ? (
          <span className="skill-badge skill-badge--builtin">内置不可卸载</span>
        ) : (
          <button type="button" className="skills-btn skills-btn--danger" onClick={onUninstall}>
            卸载
          </button>
        )}
      </div>
    </div>
  )
}

/** 市场技能卡片 */
function MarketCard({
  skill,
  installed,
  onInstall,
}: {
  skill: MarketSkillItem
  installed: boolean
  onInstall: () => void
}) {
  return (
    <div className="skill-card">
      <div className="skill-card__head">
        <span className="skill-card__icon">{skill.icon}</span>
        <span className="skill-card__name">{skill.name}</span>
        <div className="skill-card__badges">
          <span className="skill-badge">{CATEGORY_LABEL[skill.category]}</span>
        </div>
      </div>

      <p className="skill-card__desc">{skill.description}</p>

      <div className="skill-card__foot">
        <div className="skill-card__meta">
          {typeof skill.installs === 'number' && <span>⬇ {skill.installs.toLocaleString()}</span>}
          {typeof skill.rating === 'number' && (
            <span className="skill-card__rating">★ {skill.rating.toFixed(1)}</span>
          )}
        </div>
        {installed ? (
          <span className="skill-installed-tag">✓ 已安装</span>
        ) : (
          <button type="button" className="skills-btn skills-btn--primary" onClick={onInstall}>
            安装
          </button>
        )}
      </div>
    </div>
  )
}
