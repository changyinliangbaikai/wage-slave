import { useMemo, useState } from 'react'
import type { MarketSkillItem, SkillCategory } from '@shared/types'

const CATEGORY_LABEL: Record<SkillCategory, string> = {
  productivity: '生产力',
  file: '文件',
  code: '代码',
  writing: '写作',
  automation: '自动化',
  custom: '自定义',
}

type CategoryFilter = SkillCategory | 'all'

interface SkillMarketProps {
  skills: MarketSkillItem[]
  installedIds: Set<string>
  loading: boolean
  onRefresh: () => void
  onInstall: (id: string) => void
}

export function SkillMarket({
  skills,
  installedIds,
  loading,
  onRefresh,
  onInstall,
}: SkillMarketProps) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<CategoryFilter>('all')
  const filteredSkills = useMemo(() => {
    const q = query.trim().toLowerCase()
    return skills.filter(skill => {
      if (category !== 'all' && skill.category !== category) return false
      if (!q) return true
      const haystack = [
        skill.name,
        skill.description,
        skill.author,
        skill.category,
        ...(skill.triggers ?? []),
        ...(skill.recommendedTools ?? []),
        ...(skill.meta?.tags ?? []),
      ].join('\n').toLowerCase()
      return haystack.includes(q)
    })
  }, [skills, query, category])

  const availableCategories = useMemo(() => {
    const set = new Set<SkillCategory>()
    skills.forEach(skill => set.add(skill.category))
    return Array.from(set)
  }, [skills])

  return (
    <>
      <div className="skills-toolbar">
        <input
          className="skills-search"
          placeholder="搜索市场技能（名称 / 描述 / 关键词）"
          value={query}
          onChange={e => setQuery(e.target.value)}
        />
        <select
          className="skills-category-select"
          value={category}
          onChange={e => setCategory(e.target.value as CategoryFilter)}
        >
          <option value="all">全部分类</option>
          {availableCategories.map(c => (
            <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>
          ))}
        </select>
        <button type="button" className="skills-btn" onClick={onRefresh} disabled={loading}>
          刷新
        </button>
      </div>

      {loading ? (
        <div className="skills-loading">正在拉取市场…</div>
      ) : skills.length === 0 ? (
        <div className="skills-empty">市场暂无可用技能</div>
      ) : filteredSkills.length === 0 ? (
        <div className="skills-empty">没有匹配的市场技能</div>
      ) : (
        <div className="skills-list">
          {filteredSkills.map(skill => (
            <MarketCard
              key={skill.id}
              skill={skill}
              installed={installedIds.has(skill.id)}
              onInstall={() => onInstall(skill.id)}
            />
          ))}
        </div>
      )}
    </>
  )
}

function MarketCard({
  skill,
  installed,
  onInstall,
}: {
  skill: MarketSkillItem
  installed: boolean
  onInstall: () => void
}) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="skill-card">
      <div className="skill-card__head">
        <span className="skill-card__icon">{skill.icon}</span>
        <span className="skill-card__name">{skill.name}</span>
        <div className="skill-card__badges">
          <span className="skill-badge">{CATEGORY_LABEL[skill.category]}</span>
          <span className="skill-badge skill-badge--remote">市场</span>
        </div>
      </div>

      <p className="skill-card__desc">{skill.description}</p>

      {expanded && (
        <div className="skill-card__details">
          <div>
            <span>作者</span>
            <strong>{skill.author}</strong>
          </div>
          <div>
            <span>版本</span>
            <strong>{skill.version}</strong>
          </div>
          {skill.triggers?.length > 0 && (
            <div className="wide">
              <span>触发词</span>
              <p>{skill.triggers.join(' / ')}</p>
            </div>
          )}
          {skill.recommendedTools?.length > 0 && (
            <div className="wide">
              <span>推荐工具</span>
              <p>{skill.recommendedTools.join(', ')}</p>
            </div>
          )}
          {skill.meta?.tags?.length ? (
            <div className="wide">
              <span>标签</span>
              <p>{skill.meta.tags.join(' / ')}</p>
            </div>
          ) : null}
        </div>
      )}

      <div className="skill-card__foot">
        <div className="skill-card__meta">
          {typeof skill.installs === 'number' && <span>⬇ {skill.installs.toLocaleString()}</span>}
          {typeof skill.rating === 'number' && (
            <span className="skill-card__rating">★ {skill.rating.toFixed(1)}</span>
          )}
        </div>
        <div className="skill-card__actions">
          <button type="button" className="skills-btn" onClick={() => setExpanded(v => !v)}>
            {expanded ? '收起' : '详情'}
          </button>
          {installed ? (
            <span className="skill-installed-tag">✓ 已安装</span>
          ) : (
            <button type="button" className="skills-btn skills-btn--primary" onClick={onInstall}>
              安装
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
