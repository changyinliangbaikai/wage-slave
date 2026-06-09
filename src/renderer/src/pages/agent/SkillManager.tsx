import { useState } from 'react'
import type { SkillCategory, SkillConfig, SkillScope, SkillWithState } from '@shared/types'

const CATEGORY_LABEL: Record<SkillCategory, string> = {
  productivity: '生产力',
  file: '文件',
  code: '代码',
  writing: '写作',
  automation: '自动化',
  custom: '自定义',
}

const SCOPE_LABEL: Record<SkillScope, string> = {
  builtin: '内置',
  user: '自定义',
  remote: '远程',
}

interface SkillManagerProps {
  skills: SkillWithState[]
  loading: boolean
  query: string
  showUrlInput: boolean
  url: string
  onQueryChange: (value: string) => void
  onInstallFile: () => void
  onToggleUrlInput: () => void
  onUrlChange: (value: string) => void
  onInstallUrl: () => void
  onToggleSkill: (id: string) => void
  onUpdateSkillConfig: (skill: SkillWithState, config: SkillConfig) => Promise<{ ok: boolean; error?: string }>
  onUninstallSkill: (skill: SkillWithState) => void
}

export function SkillManager({
  skills,
  loading,
  query,
  showUrlInput,
  url,
  onQueryChange,
  onInstallFile,
  onToggleUrlInput,
  onUrlChange,
  onInstallUrl,
  onToggleSkill,
  onUpdateSkillConfig,
  onUninstallSkill,
}: SkillManagerProps) {
  return (
    <>
      <div className="skills-toolbar">
        <input
          className="skills-search"
          placeholder="搜索技能（名称 / 描述 / 关键词）"
          value={query}
          onChange={e => onQueryChange(e.target.value)}
        />
        <button type="button" className="skills-btn" onClick={onInstallFile}>
          从文件/zip 安装
        </button>
        <button type="button" className="skills-btn" onClick={onToggleUrlInput}>
          从 URL 安装
        </button>
      </div>

      {showUrlInput && (
        <div className="skills-url-row">
          <input
            placeholder="https://.../skill.json 或 .zip"
            value={url}
            onChange={e => onUrlChange(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') onInstallUrl()
            }}
          />
          <button type="button" className="skills-btn skills-btn--primary" onClick={onInstallUrl}>
            安装
          </button>
        </div>
      )}

      {loading ? (
        <div className="skills-loading">加载中…</div>
      ) : skills.length === 0 ? (
        <div className="skills-empty">没有匹配的技能</div>
      ) : (
        <div className="skills-list">
          {skills.map(skill => (
            <InstalledCard
              key={skill.id}
              skill={skill}
              onToggle={() => onToggleSkill(skill.id)}
              onUpdateConfig={(config) => onUpdateSkillConfig(skill, config)}
              onUninstall={() => onUninstallSkill(skill)}
            />
          ))}
        </div>
      )}
    </>
  )
}

function InstalledCard({
  skill,
  onToggle,
  onUpdateConfig,
  onUninstall,
}: {
  skill: SkillWithState
  onToggle: () => void
  onUpdateConfig: (config: SkillConfig) => Promise<{ ok: boolean; error?: string }>
  onUninstall: () => void
}) {
  const [configOpen, setConfigOpen] = useState(false)
  const [configDraft, setConfigDraft] = useState(() => JSON.stringify(skill.config ?? {}, null, 2))
  const [configError, setConfigError] = useState('')

  const resetConfigDraft = () => {
    setConfigDraft(JSON.stringify(skill.config ?? {}, null, 2))
    setConfigError('')
  }

  const toggleConfigPanel = () => {
    if (!configOpen) resetConfigDraft()
    setConfigOpen(v => !v)
  }

  const saveConfig = async () => {
    try {
      const parsed = JSON.parse(configDraft) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setConfigError('配置必须是 JSON 对象，例如 {"tone":"正式"}')
        return
      }
      const res = await onUpdateConfig(parsed as SkillConfig)
      if (res.ok) {
        setConfigOpen(false)
        setConfigError('')
      } else {
        setConfigError(res.error ?? '保存失败')
      }
    } catch (e) {
      setConfigError(e instanceof Error ? e.message : 'JSON 格式错误')
    }
  }

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

      {configOpen && (
        <div className="skill-config-panel">
          <label>
            <span>技能配置 JSON</span>
            <textarea
              value={configDraft}
              onChange={e => setConfigDraft(e.target.value)}
              spellCheck={false}
            />
          </label>
          {configError && <div className="skill-config-error">{configError}</div>}
          <div className="skill-config-actions">
            <button type="button" className="skills-btn skills-btn--primary" onClick={saveConfig}>
              保存配置
            </button>
            <button
              type="button"
              className="skills-btn"
              onClick={() => {
                resetConfigDraft()
                setConfigOpen(false)
              }}
            >
              取消
            </button>
          </div>
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
          <div className="skill-card__actions">
            <button type="button" className="skills-btn" onClick={toggleConfigPanel}>
              配置
            </button>
            <span className="skill-badge skill-badge--builtin">内置不可卸载</span>
          </div>
        ) : (
          <div className="skill-card__actions">
            <button type="button" className="skills-btn" onClick={toggleConfigPanel}>
              配置
            </button>
            <button type="button" className="skills-btn skills-btn--danger" onClick={onUninstall}>
              卸载
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
