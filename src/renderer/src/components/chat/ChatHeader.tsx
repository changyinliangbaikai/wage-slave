import { useState, useEffect, useCallback } from 'react'
import { IPC } from '@shared/ipc-channels'
import { useClickOutside } from '../../hooks/useClickOutside'
import './ChatHeader.css'

interface AppConfig {
  llm_model?: string
  agent_reasoning_effort?: string
}

interface ChatHeaderProps {
  title: string
  running: boolean
  tokenInfo: {
    prompt: number
    max: number
    ratio: number
    cacheHit?: number
  } | null
  onRename: () => void
  onCompact: () => void
  onDelete: () => void
}

export default function ChatHeader({
  title,
  running,
  tokenInfo,
  onRename,
  onCompact,
  onDelete,
}: ChatHeaderProps) {
  const [modelName, setModelName] = useState('Claude 3.5 Sonnet')
  const [reasoningEffort, setReasoningEffort] = useState<string>('')
  const [showModelMenu, setShowModelMenu] = useState(false)
  const [showEffortMenu, setShowEffortMenu] = useState(false)
  const [showOptionsMenu, setShowOptionsMenu] = useState(false)
  const [showTokenPopover, setShowTokenPopover] = useState(false)
  const [modelsList, setModelsList] = useState<string[]>([
    'claude-3-5-sonnet-20241022',
    'deepseek-chat',
    'gpt-4o',
    'gemini-2.5-pro',
    'gemini-2.5-flash',
  ])

  // useClickOutside for each dropdown
  const closeModelMenu = useCallback(() => setShowModelMenu(false), [])
  const closeEffortMenu = useCallback(() => setShowEffortMenu(false), [])
  const closeOptionsMenu = useCallback(() => setShowOptionsMenu(false), [])
  const closeTokenPopover = useCallback(() => setShowTokenPopover(false), [])

  const modelMenuRef = useClickOutside<HTMLDivElement>(showModelMenu, closeModelMenu)
  const effortMenuRef = useClickOutside<HTMLDivElement>(showEffortMenu, closeEffortMenu)
  const optionsMenuRef = useClickOutside<HTMLDivElement>(showOptionsMenu, closeOptionsMenu)
  const tokenMenuRef = useClickOutside<HTMLDivElement>(showTokenPopover, closeTokenPopover)

  // Read current LLM model & reasoning effort from main config store
  useEffect(() => {
    window.electronAPI.invoke(IPC.CONFIG_GET)
      .then((config) => {
        const cfg = config as AppConfig
        if (cfg) {
          if (cfg.llm_model) setModelName(cfg.llm_model)
          setReasoningEffort(cfg.agent_reasoning_effort || '')
        }
      })
      .catch((err) => {
        console.error('[ChatHeader] Failed to load config:', err)
      })
  }, [])

  const handleSelectModel = async (model: string) => {
    setModelName(model)
    await window.electronAPI.invoke(IPC.CONFIG_SET, { llm_model: model })
    setShowModelMenu(false)
  }

  const handleSelectEffort = async (effort: string) => {
    setReasoningEffort(effort)
    await window.electronAPI.invoke(IPC.CONFIG_SET, { agent_reasoning_effort: effort })
    setShowEffortMenu(false)
  }

  const effortLabels: Record<string, string> = {
    '': '关闭',
    'low': '低',
    'medium': '中',
    'high': '高',
    'max': '超高',
  }

  const effortOptions = [
    { label: '关闭 (Off)', value: '' },
    { label: '低 (Low)', value: 'low' },
    { label: '中 (Medium)', value: 'medium' },
    { label: '高 (High)', value: 'high' },
    { label: '超高 (Max)', value: 'max' },
  ]

  return (
    <header className="codex-header">
      {/* Title & Options Dropdown */}
      <div className="codex-header__title-group">
        <h2 className="codex-header__title" title={title}>
          {title || '新对话'}
        </h2>
        <div className="codex-header__menu-wrapper" ref={optionsMenuRef}>
          <button 
            type="button" 
            className="codex-header__icon-btn" 
            onClick={() => setShowOptionsMenu(!showOptionsMenu)}
            disabled={running}
            aria-label="会话菜单"
          >
            •••
          </button>
          {showOptionsMenu && (
            <div className="codex-header__dropdown-menu">
              <button type="button" className="dropdown-item" onClick={() => { onRename(); setShowOptionsMenu(false); }}>✍ 重命名任务</button>
              <button type="button" className="dropdown-item" onClick={() => { onCompact(); setShowOptionsMenu(false); }}>💾 物理压缩历史</button>
              <div className="dropdown-divider" />
              <button type="button" className="dropdown-item dropdown-item--danger" onClick={() => { onDelete(); setShowOptionsMenu(false); }}>🗑 删除会话</button>
            </div>
          )}
        </div>
      </div>

      {/* Drag spacer for seamless borderless window movement */}
      <div className="codex-header__drag-area" />

      {/* Context info stats & LLM Model Select drop-pills */}
      <div className="codex-header__right-group">
        {tokenInfo && (
          <div 
            ref={tokenMenuRef}
            className="context-ring-wrapper" 
            onClick={() => setShowTokenPopover(!showTokenPopover)}
          >
            <svg width="20" height="20" viewBox="0 0 20 20">
              <circle cx="10" cy="10" r="8" fill="none" stroke="var(--agent-border, #e5e0d1)" strokeWidth="2.5" />
              <circle
                cx="10"
                cy="10"
                r="8"
                fill="none"
                stroke={tokenInfo.ratio > 80 ? 'var(--agent-error, #c0392b)' : 'var(--agent-primary, #c0733a)'}
                strokeWidth="2.5"
                strokeDasharray="50.26"
                strokeDashoffset={50.26 * (1 - Math.min(100, tokenInfo.ratio) / 100)}
                strokeLinecap="round"
                transform="rotate(-90 10 10)"
                style={{ transition: 'stroke-dashoffset 0.35s ease' }}
              />
            </svg>
            
            {showTokenPopover && (
              <div className="codex-header__token-popover" onClick={e => e.stopPropagation()}>
                <div className="token-popover__title">
                  上下文占用
                </div>
                <div className="token-popover__row">
                  <span className="token-popover__label">占用比例</span>
                  <span className="token-popover__value">{tokenInfo.ratio}%</span>
                </div>
                <div className="token-popover__row">
                  <span className="token-popover__label">已用 Token</span>
                  <span className="token-popover__value">
                    {Math.round(tokenInfo.prompt / 1000)}k / {Math.round(tokenInfo.max / 1000)}k
                  </span>
                </div>
                {typeof tokenInfo.cacheHit === 'number' && (
                  <div className="token-popover__row">
                    <span className="token-popover__label">缓存命中</span>
                    <span className="token-popover__value token-popover__value--accent">
                      {Math.round(tokenInfo.cacheHit / 1000)}k
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Model Dropdown Pill */}
        <div className="codex-header__model-selector-wrapper" ref={modelMenuRef}>
          <button 
            type="button" 
            className="codex-header__model-btn" 
            onClick={() => setShowModelMenu(!showModelMenu)}
            disabled={running}
          >
            🧠 <span className="model-name-text">{modelName}</span> <span className="dropdown-arrow">▾</span>
          </button>
          {showModelMenu && (
            <div className="codex-header__model-dropdown">
              {modelsList.map(m => (
                <button 
                  key={m} 
                  type="button" 
                  className={`model-option-item ${modelName === m ? 'is-active' : ''}`}
                  onClick={() => handleSelectModel(m)}
                >
                  {m}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Inference Level Dropdown Pill */}
        <div className="codex-header__model-selector-wrapper" ref={effortMenuRef}>
          <button 
            type="button" 
            className="codex-header__model-btn" 
            onClick={() => setShowEffortMenu(!showEffortMenu)}
            disabled={running}
          >
            ⚡️ <span className="model-name-text">推理: {effortLabels[reasoningEffort] || '关闭'}</span> <span className="dropdown-arrow">▾</span>
          </button>
          {showEffortMenu && (
            <div className="codex-header__model-dropdown">
              {effortOptions.map(opt => (
                <button 
                  key={opt.value} 
                  type="button" 
                  className={`model-option-item ${reasoningEffort === opt.value ? 'is-active' : ''}`}
                  onClick={() => handleSelectEffort(opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </header>
  )
}
