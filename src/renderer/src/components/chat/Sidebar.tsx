import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import {
  togglePinProject,
  showProjectInExplorer,
  renameProject,
  deleteProject,
  pickProjectDir,
  createProject,
  searchChatSessions,
} from '../../hooks/useChat'
import { useClickOutside } from '../../hooks/useClickOutside'
import type { Project } from '@shared/types-project'
import type { ChatSessionMeta, ChatSearchHit } from '@shared/types-chat'
import { alert as modalAlert, confirm as modalConfirm, prompt as modalPrompt } from '../Modal/Modal'
import './Sidebar.css'

// Format timestamp to short relative display
function formatMetaTime(ts: number, now: number): string {
  const diff = now - ts
  if (diff < 0) return '刚刚'
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return '刚刚'
  if (mins < 60) return `${mins}分钟前`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}小时前`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}天前`
  const weeks = Math.floor(days / 7)
  return `${weeks}周前`
}

interface SidebarProps {
  projects: Project[]
  currentProjectId: string
  currentSessionId: string
  sessions: ChatSessionMeta[]
  onSwitchProject: (id: string) => void
  onLoadSession: (id: string) => void
  onNewSession: () => void
  onOpenSettings: () => void
  onProjectsChanged?: () => void
  onSearchClick?: () => void
}

export default function Sidebar({
  projects,
  currentProjectId,
  currentSessionId,
  sessions,
  onSwitchProject,
  onLoadSession,
  onNewSession,
  onOpenSettings,
  onProjectsChanged,
  onSearchClick,
}: SidebarProps) {
  const [showAccountMenu, setShowAccountMenu] = useState(false)
  const isMac = navigator.userAgent.toLowerCase().includes('mac')

  // 搜索模式状态
  const [searchMode, setSearchMode] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<ChatSearchHit[]>([])
  const [searching, setSearching] = useState(false)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Auto-refresh relative time every 60 seconds
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])

  // Close account menu on outside click
  const closeAccountMenu = useCallback(() => setShowAccountMenu(false), [])
  const popoverRef = useClickOutside<HTMLDivElement>(showAccountMenu, closeAccountMenu)

  // Memoized session grouping
  const standaloneSessions = useMemo(
    () => sessions.filter(s => !s.projectId || s.projectId === 'default'),
    [sessions],
  )

  const projectSessionsMap = useMemo(() => {
    const map = new Map<string, ChatSessionMeta[]>()
    for (const s of sessions) {
      if (!s.projectId || s.projectId === 'default') continue
      const list = map.get(s.projectId) ?? []
      list.push(s)
      map.set(s.projectId, list)
    }
    return map
  }, [sessions])

  const [expandedProjectIds, setExpandedProjectIds] = useState<Record<string, boolean>>({})
  const [activeMenuProjectId, setActiveMenuProjectId] = useState<string | null>(null)

  // Auto-expand currentProjectId when it changes
  useEffect(() => {
    if (currentProjectId && currentProjectId !== 'default') {
      setExpandedProjectIds(prev => ({ ...prev, [currentProjectId]: true }))
    }
  }, [currentProjectId])

  // Close project action menu on outside click
  const closeProjectMenu = useCallback(() => setActiveMenuProjectId(null), [])
  const menuRef = useClickOutside<HTMLDivElement>(activeMenuProjectId !== null, closeProjectMenu)

  const toggleProjectExpand = (projId: string) => {
    setExpandedProjectIds(prev => ({ ...prev, [projId]: !prev[projId] }))
  }

  // 进入搜索模式
  const enterSearch = useCallback(() => {
    setSearchMode(true)
    setSearchQuery('')
    setSearchResults([])
    setSearching(false)
    setTimeout(() => searchInputRef.current?.focus(), 50)
  }, [])

  // 退出搜索模式
  const exitSearch = useCallback(() => {
    setSearchMode(false)
    setSearchQuery('')
    setSearchResults([])
    setSearching(false)
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = null
    }
  }, [])

  // Debounced 搜索
  const doSearch = useCallback((query: string) => {
    const q = query.trim()
    if (!q) {
      setSearchResults([])
      setSearching(false)
      return
    }
    setSearching(true)
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)
    debounceTimerRef.current = setTimeout(async () => {
      const hits = await searchChatSessions(q)
      setSearchResults(hits)
      setSearching(false)
    }, 300)
  }, [])

  // 清理 debounce timer
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)
    }
  }, [])

  const handlePin = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setActiveMenuProjectId(null)
    const success = await togglePinProject(id)
    if (success && onProjectsChanged) {
      onProjectsChanged()
    }
  }

  const handleShowInExplorer = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setActiveMenuProjectId(null)
    const success = await showProjectInExplorer(id)
    if (!success) {
      await modalAlert('打开项目目录失败，请检查目录是否被移动或删除。', '操作失败')
    }
  }

  const handleRename = async (proj: Project, e: React.MouseEvent) => {
    e.stopPropagation()
    setActiveMenuProjectId(null)
    const newName = await modalPrompt('请输入项目新名称：', proj.name, '重命名项目')
    if (newName && newName.trim()) {
      const success = await renameProject(proj.id, newName.trim())
      if (success && onProjectsChanged) {
        onProjectsChanged()
      }
    }
  }

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setActiveMenuProjectId(null)
    const confirmRes = await modalConfirm(
      '确定要移除该项目吗？此操作仅在小牛马内移除项目，您的物理目录和文件将被完整保留。', 
      '移除项目确认'
    )
    if (confirmRes) {
      const success = await deleteProject(id)
      if (success && onProjectsChanged) {
        onProjectsChanged()
      }
    }
  }

  const handleCreateProject = async () => {
    const dirPath = await pickProjectDir()
    if (!dirPath) return

    const defaultName = dirPath.split(/[\\/]/).pop() || '新项目'
    const name = await modalPrompt('请输入项目名称：', defaultName, '添加项目')
    if (!name || !name.trim()) return

    const res = await createProject({
      name: name.trim(),
      path: dirPath,
      createDir: false
    })

    if (res.ok) {
      if (onProjectsChanged) {
        onProjectsChanged()
      }
    } else {
      await modalAlert(`添加项目失败：${res.error || '未知错误'}`, '添加项目失败')
    }
  }

  return (
    <aside className="codex-sidebar">
      {/* 侧边栏顶部拖拽区（留出 macOS 交通灯空间并支持窗口拖拽） */}
      <div className="sidebar-header"></div>

      {/* 快捷动作 */}
      <div className="sidebar-action-items">
        <button type="button" className="sidebar-action-btn" onClick={onNewSession}>
          <span>📝</span> 新对话
        </button>
        <button type="button" className="sidebar-action-btn" onClick={enterSearch}>
          <span>🔍</span> 搜索
        </button>
        <button type="button" className="sidebar-action-btn" onClick={() => { window.electronAPI.invoke('renderer:open-skills') }}>
          <span>🧩</span> 插件
        </button>
      </div>

      {/* 搜索面板 或 树形列表组 */}
      {searchMode ? (
        <div className="sidebar-search-panel">
          <div className="sidebar-search-header">
            <button type="button" className="sidebar-search-back" onClick={exitSearch} title="返回">
              ◀
            </button>
            <input
              ref={searchInputRef}
              type="text"
              className="sidebar-search-input"
              placeholder="搜索对话内容…"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value)
                doSearch(e.target.value)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') exitSearch()
              }}
            />
            {searchQuery && (
              <button type="button" className="sidebar-search-clear" onClick={() => {
                setSearchQuery('')
                setSearchResults([])
                searchInputRef.current?.focus()
              }}>
                ✕
              </button>
            )}
          </div>
          <div className="sidebar-search-results">
            {searching && (
              <div className="sidebar-search-status">搜索中…</div>
            )}
            {!searching && searchQuery && searchResults.length === 0 && (
              <div className="sidebar-search-status">未找到匹配的对话</div>
            )}
            {!searching && !searchQuery && (
              <div className="sidebar-search-status">输入关键词搜索所有对话</div>
            )}
            {!searching && searchResults.length > 0 && (
              <>
                <div className="sidebar-search-count">找到 {searchResults.length} 条结果</div>
                {searchResults.map(hit => (
                  <div
                    key={hit.sessionId}
                    className={`sidebar-search-result-item ${currentSessionId === hit.sessionId ? 'is-selected' : ''}`}
                    onClick={() => {
                      onLoadSession(hit.sessionId)
                      exitSearch()
                    }}
                  >
                    <div className="sidebar-search-result-title" title={hit.title}>
                      {hit.title}
                    </div>
                    {hit.snippet && (
                      <div className="sidebar-search-result-snippet">{hit.snippet}</div>
                    )}
                    <div className="sidebar-search-result-meta">
                      <span>{formatMetaTime(hit.updatedAt, now)}</span>
                      <span className="sidebar-search-result-hits">{hit.matchCount} 处匹配</span>
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      ) : (
      <div className="sidebar-tree-section">
        {/* 项目板块 */}
        <div className="tree-section-title sidebar-tree-section-title">
          <span>项目</span>
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
            <button
              type="button"
              className="sidebar-add-project-btn"
              onClick={handleCreateProject}
              title="添加项目 (关联本地文件夹)"
            >
              ＋
            </button>
            <button
              type="button"
              className="sidebar-collapse-all-btn"
              onClick={() => setExpandedProjectIds({})}
            >
              收起全部
            </button>
          </div>
        </div>
        <div className="project-tree-list">
          {projects.filter(p => p.id !== 'default').map(p => {
            const isCurrent = currentProjectId === p.id
            const isExpanded = !!expandedProjectIds[p.id]
            const projSessions = projectSessionsMap.get(p.id) ?? []
            return (
              <div key={p.id} className="project-tree-node">
                <div
                  className={`project-folder-node ${isCurrent ? 'is-current' : ''}`}
                  onClick={() => toggleProjectExpand(p.id)}
                >
                  <div className="project-folder-node__main">
                    <span className="project-folder-icon">{isExpanded ? '📂' : '📁'}</span>
                    <span className="project-folder-name" title={p.name}>
                      {p.name}
                    </span>
                    {p.pinned && <span className="project-folder-pinned">📌</span>}
                  </div>
                  <div className="project-folder-actions">
                    <button
                      type="button"
                      className="project-new-chat-btn"
                      title="在项目内新建对话"
                      onClick={(e) => {
                        e.stopPropagation()
                        onSwitchProject(p.id)
                        onNewSession()
                      }}
                    >
                      📝
                    </button>
                    <button
                      type="button"
                      className={`project-action-trigger-btn ${activeMenuProjectId === p.id ? 'is-visible' : ''}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        setActiveMenuProjectId(activeMenuProjectId === p.id ? null : p.id)
                      }}
                    >
                      •••
                    </button>
                  </div>
                </div>

                {activeMenuProjectId === p.id && (
                  <div className="project-action-menu" ref={menuRef} onClick={e => e.stopPropagation()}>
                    <button type="button" className="project-action-item" onClick={(e) => handlePin(p.id, e)}>
                      <span>📌</span> {p.pinned ? '取消置顶' : '置顶项目'}
                    </button>
                    <button type="button" className="project-action-item" onClick={(e) => handleShowInExplorer(p.id, e)}>
                      <span>📂</span> {isMac ? '在 Finder 中显示' : '在资源管理器中显示'}
                    </button>
                    <button type="button" className="project-action-item" onClick={(e) => handleRename(p, e)}>
                      <span>✏️</span> 重命名项目
                    </button>
                    <button type="button" className={`project-action-item is-danger`} onClick={(e) => handleDelete(p.id, e)}>
                      <span>❌</span> 移除项目
                    </button>
                  </div>
                )}
                {/* 展开显示该项目的任务/会话 */}
                {isExpanded && (
                  <div className="project-sessions-sublist">
                    {projSessions.length === 0 ? (
                      <div className="session-node-empty session-node-empty--project">暂无任务</div>
                    ) : (
                      projSessions.map(s => (
                        <div
                          key={s.id}
                          className={`session-node-item ${currentSessionId === s.id ? 'is-selected' : ''}`}
                          onClick={() => onLoadSession(s.id)}
                        >
                          <span className="session-node-title" title={s.title}>📄 {s.title}</span>
                          <span className="session-node-meta">
                            {formatMetaTime(s.updatedAt, now)}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {/* 独立快速对话 */}
        <div className="tree-section-title sidebar-header-with-action sidebar-standalone-title">
          <span>对话</span>
          <button
            type="button"
            className="sidebar-add-chat-btn"
            onClick={() => {
              onSwitchProject('default')
              onNewSession()
            }}
            title="新建独立对话"
          >
            📝
          </button>
        </div>
        <div className="project-sessions-list">
          {standaloneSessions.length === 0 ? (
            <div className="session-node-empty session-node-empty--standalone">暂无历史对话</div>
          ) : (
            standaloneSessions.map(s => (
              <div 
                key={s.id} 
                className={`session-node-item ${currentSessionId === s.id ? 'is-selected' : ''}`}
                onClick={() => onLoadSession(s.id)}
              >
                <span className="session-node-title" title={s.title}>💬 {s.title}</span>
                <span className="session-node-meta">{formatMetaTime(s.updatedAt, now)}</span>
              </div>
            ))
          )}
        </div>
      </div>
      )}

      {/* 用户 Profile 底部栏 */}
      <div className="sidebar-user-panel-wrapper">
        {showAccountMenu && (
          <div className="codex-account-popover" ref={popoverRef}>
            <div className="popover-section is-disabled" title="暂未接入账户服务">
              <div className="popover-email">user@email.com</div>
              <div className="popover-item">👤 个人帐户</div>
            </div>

            <div className="popover-divider" />

            <div className="popover-section">
              <div className="popover-item is-disabled">ℹ 个人资料</div>
              <button 
                type="button" 
                className="popover-item is-clickable" 
                onClick={() => {
                  onOpenSettings()
                  setShowAccountMenu(false)
                }}
              >
                <span>⚙ 设置</span>
                <span className="popover-shortcut">⌘,</span>
              </button>
            </div>
          </div>
        )}

        <div className="sidebar-user-panel" onClick={() => setShowAccountMenu(!showAccountMenu)}>
          <div className="user-panel__info">
            <div className="user-panel__avatar">U</div>
            <div className="user-panel__name-group">
              <span className="user-panel__name">user</span>
              <span className="user-panel__tag">Active</span>
            </div>
          </div>
          <button type="button" className="user-panel__settings-btn" onClick={(e) => {
            e.stopPropagation()
            onOpenSettings()
          }}>
            ⚙
          </button>
        </div>
      </div>
    </aside>
  )
}
