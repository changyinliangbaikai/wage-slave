import { useEffect, useRef, useState } from 'react'
import type { AgentSecurityPolicy, AgentToolGroupMeta, AppConfig } from '@shared/types'
import { formatTokens } from '../../utils/format-tokens'

interface AgentSettingsProps {
  config: AppConfig
  toolGroups: AgentToolGroupMeta[]
  securityPolicy: AgentSecurityPolicy | null
  onChange: (patch: Partial<AppConfig>) => void
}

/** 上下文长度快捷预设（值与显示标签强绑定，避免 8192 被显示成 "8.2k"） */
const CONTEXT_PRESETS: { label: string; value: number }[] = [
  { label: '8k', value: 8192 },
  { label: '16k', value: 16_384 },
  { label: '32k', value: 32_768 },
  { label: '64k', value: 65_536 },
  { label: '128k', value: 128_000 },
  { label: '200k', value: 200_000 },
  { label: '1M', value: 1_000_000 },
]

export function AgentSettings({
  config,
  toolGroups,
  securityPolicy,
  onChange,
}: AgentSettingsProps) {
  const [newAllowedPath, setNewAllowedPath] = useState('')
  const [showAllBlacklist, setShowAllBlacklist] = useState(false)
  const customAllowedPaths = config.agent_allowed_paths_extra ?? []

  const setCustomAllowedPaths = (paths: string[]) => {
    const cleaned = Array.from(new Set(paths.map(p => p.trim()).filter(Boolean)))
    onChange({ agent_allowed_paths_extra: cleaned })
  }

  const addCustomAllowedPath = () => {
    const value = newAllowedPath.trim()
    if (!value) return
    setCustomAllowedPaths([...customAllowedPaths, value])
    setNewAllowedPath('')
  }

  // 上下文窗口（tokens）：0 表示按模型名自动识别，>0 强制覆盖
  // 这里保留字符串状态，允许用户清空后再输入，不会跳回 0
  const contextWindow = config.agent_context_window ?? 0
  // 自动识别值始终基于上方"模型配置"section 中的全局 llm_model
  const autoInferredFromModelName = inferContextWindowFromModelName(config.llm_model)

  return (
    <>
      <section className="settings-section">
        <h2>Agent 行为</h2>
        <p style={{ fontSize: 12, color: '#8a7e5e', marginBottom: 12 }}>
          Agent 共用上方「模型配置」中的 LLM。这里只调整 Agent 任务执行时的额外参数。
        </p>
        <div className="field-row">
          <label>最大执行步数</label>
          <input
            type="number"
            min={1}
            max={50}
            value={config.agent_max_iterations ?? 20}
            onChange={e => onChange({ agent_max_iterations: Number(e.target.value) })}
          />
        </div>
        <div className="field-row" style={{ alignItems: 'flex-start' }}>
          <label style={{ paddingTop: 4 }}>上下文长度（tokens）</label>
          <div style={{ flex: 1, maxWidth: 240, display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                type="number"
                min={0}
                step={1024}
                value={contextWindow}
                onChange={e => {
                  const v = e.target.value
                  // 允许清空 → 0（自动），允许整数；忽略 NaN
                  const num = v === '' ? 0 : Number(v)
                  if (!Number.isFinite(num) || num < 0) return
                  onChange({ agent_context_window: Math.floor(num) })
                }}
                placeholder="0 表示自动识别"
                style={{ flex: 1, minWidth: 0 }}
              />
              <button
                type="button"
                className="btn-test"
                style={{ padding: '4px 10px', fontSize: 11 }}
                onClick={() => onChange({ agent_context_window: 0 })}
                title="改回按模型名自动识别"
              >
                自动
              </button>
            </div>
            <div style={{ fontSize: 11, color: '#8a7e5e', lineHeight: 1.5 }}>
              {contextWindow > 0 ? (
                <>已强制使用 <b>{formatTokens(contextWindow)}</b>（{contextWindow.toLocaleString()} tokens）。</>
              ) : (
                <>当前自动识别为 <b>{formatTokens(autoInferredFromModelName)}</b>（{autoInferredFromModelName.toLocaleString()} tokens，按模型 <code>{config.llm_model || '未配置'}</code>）。</>
              )}
            </div>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {CONTEXT_PRESETS.map(preset => (
                <button
                  key={preset.value}
                  type="button"
                  className="btn-test"
                  style={{ padding: '2px 8px', fontSize: 10 }}
                  onClick={() => onChange({ agent_context_window: preset.value })}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <div style={{ fontSize: 10, color: '#8a7e5e', lineHeight: 1.5 }}>
              用于顶部 Context 占比显示与历史压缩阈值。私有 / 自托管模型识别不准时手动指定。
            </div>
          </div>
        </div>
      </section>

      <section className="settings-section">
        <h2>Agent 工具权限</h2>
        <p style={{ fontSize: 12, color: '#8a7e5e', marginBottom: 12 }}>
          关闭某个工具组后，Agent 在本轮会话中无法调用该组工具。LLM 会尝试用其他方式完成任务。
        </p>
        {toolGroups.map(group => (
          <ToolGroupSettingRow
            key={group.id}
            group={group}
            disabledTools={config.agent_disabled_tools ?? []}
            onChange={tools => onChange({ agent_disabled_tools: tools })}
          />
        ))}
      </section>

      <section className="settings-section">
        <h2>Agent 安全策略</h2>
        <p style={{ fontSize: 12, color: '#8a7e5e', marginBottom: 12 }}>
          以下安全策略由应用内置，暂不支持用户修改。如需调整，请提交 Issue 或自行修改源码。
        </p>
        {securityPolicy && (
          <>
            <div className="field-row" style={{ alignItems: 'flex-start' }}>
              <label style={{ paddingTop: 4 }}>路径白名单</label>
              <div style={{ flex: 1, maxWidth: 240, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ fontSize: 11, color: '#8a7e5e', lineHeight: 1.4 }}>
                  Agent 只能访问以下默认路径及其子目录：
                </div>
                <ul style={{ fontSize: 10, color: '#8a7e5e', margin: 0, paddingLeft: 16, lineHeight: 1.6 }}>
                  {(securityPolicy.defaultAllowedPaths ?? securityPolicy.allowedPaths).map(p => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </div>
            </div>
            <div className="field-row" style={{ alignItems: 'flex-start' }}>
              <label style={{ paddingTop: 4 }}>额外允许目录</label>
              <div style={{ flex: 1, maxWidth: 240, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {customAllowedPaths.length > 0 ? (
                  <ul style={{ fontSize: 10, color: '#8a7e5e', margin: 0, paddingLeft: 16, lineHeight: 1.6 }}>
                    {customAllowedPaths.map(p => (
                      <li key={p} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <span style={{ flex: 1, wordBreak: 'break-all' }}>{p}</span>
                        <button
                          type="button"
                          className="btn-test"
                          style={{ padding: '2px 6px', fontSize: 10 }}
                          onClick={() => setCustomAllowedPaths(customAllowedPaths.filter(x => x !== p))}
                        >
                          删除
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div style={{ fontSize: 11, color: '#8a7e5e' }}>未添加额外目录</div>
                )}
                <div style={{ display: 'flex', gap: 6 }}>
                  <input
                    type="text"
                    value={newAllowedPath}
                    onChange={e => setNewAllowedPath(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') addCustomAllowedPath()
                    }}
                    placeholder="例如 ~/Work 或 D:\\Projects"
                    style={{ flex: 1, minWidth: 0 }}
                  />
                  <button type="button" className="btn-test" onClick={addCustomAllowedPath}>
                    添加
                  </button>
                </div>
                <div style={{ fontSize: 10, color: '#8a7e5e', lineHeight: 1.5 }}>
                  保存设置后生效；支持 <code>~/</code>，会按绝对路径前缀放行。
                </div>
              </div>
            </div>
            <div className="field-row" style={{ alignItems: 'flex-start' }}>
              <label style={{ paddingTop: 4 }}>命令黑名单</label>
              <div style={{ flex: 1, maxWidth: 240, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ fontSize: 11, color: '#8a7e5e', lineHeight: 1.4 }}>
                  以下命令被禁止执行（共 {securityPolicy.commandBlacklist.length} 条）：
                </div>
                <ul style={{ fontSize: 10, color: '#8a7e5e', margin: 0, paddingLeft: 16, lineHeight: 1.6 }}>
                  {(showAllBlacklist ? securityPolicy.commandBlacklist : securityPolicy.commandBlacklist.slice(0, 3)).map((rule, idx) => (
                    <li key={idx}>
                      <code style={{ fontSize: 9, background: '#f5f5f5', padding: '1px 3px', borderRadius: 2 }}>
                        {rule.pattern}
                      </code>
                      <span style={{ marginLeft: 4 }}>— {rule.reason}</span>
                    </li>
                  ))}
                </ul>
                {securityPolicy.commandBlacklist.length > 3 && (
                  <button
                    onClick={() => setShowAllBlacklist(!showAllBlacklist)}
                    style={{
                      fontSize: 11,
                      color: '#8a7e5e',
                      background: 'none',
                      border: '1px solid #ddd',
                      borderRadius: 4,
                      padding: '4px 8px',
                      cursor: 'pointer',
                      marginTop: 4,
                      alignSelf: 'flex-start',
                    }}
                  >
                    {showAllBlacklist ? '收起 ▲' : `展开全部 ${securityPolicy.commandBlacklist.length - 3} 条 ▼`}
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </section>
    </>
  )
}

/**
 * 根据模型名推断上下文窗口（仅前端展示用）：
 * 与 main 进程 `agent/model-info.ts` 的策略保持一致，新增模型时需同步两侧。
 * 这里做轻量复制是为了避免渲染端反复 IPC 拉取自动推断值。
 */
function inferContextWindowFromModelName(model?: string): number {
  const m = (model ?? '').toLowerCase()
  if (!m) return 32_768
  if (m.includes('gpt-4o') || m.includes('gpt-4-turbo')) return 128_000
  if (m.includes('gpt-5') || m.includes('o1') || m.includes('o3')) return 128_000
  if (m.includes('claude-3') || m.includes('claude-4') || m.includes('claude')) return 200_000
  if (m.includes('gemini')) return 128_000
  if (m.includes('deepseek')) return 64_000
  if (m.includes('qwen-max') || m.includes('qwen-plus')) return 128_000
  if (m.includes('moonshot') || m.includes('kimi')) return 128_000
  if (m.includes('minimax')) return 245_760
  if (m.includes('qwen')) return 32_768
  return 32_768
}

function ToolGroupSettingRow({
  group,
  disabledTools,
  onChange,
}: {
  group: AgentToolGroupMeta
  disabledTools: string[]
  onChange: (disabledTools: string[]) => void
}) {
  const checkboxRef = useRef<HTMLInputElement>(null)
  const allDisabled = group.toolNames.every(name => disabledTools.includes(name))
  const allEnabled = group.toolNames.every(name => !disabledTools.includes(name))
  const someDisabled = group.toolNames.some(name => disabledTools.includes(name))

  useEffect(() => {
    if (checkboxRef.current) {
      checkboxRef.current.indeterminate = someDisabled && !allDisabled
    }
  }, [someDisabled, allDisabled])

  const toggleGroup = (enable: boolean) => {
    const next = new Set(disabledTools)
    if (enable) {
      group.toolNames.forEach(name => next.delete(name))
    } else {
      group.toolNames.forEach(name => next.add(name))
    }
    onChange(Array.from(next))
  }

  return (
    <div className="field-row" style={{ alignItems: 'flex-start' }}>
      <label style={{ paddingTop: 4 }}>
        {group.label}
        {group.dangerous && <span style={{ color: '#e67e22', marginLeft: 4 }}>⚠️</span>}
      </label>
      <div style={{ flex: 1, maxWidth: 240, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ fontSize: 11, color: '#8a7e5e', lineHeight: 1.4 }}>
          {group.description}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4 }}>
            <input
              ref={checkboxRef}
              type="checkbox"
              checked={allEnabled}
              onChange={e => toggleGroup(e.target.checked)}
            />
            {allEnabled ? '已启用' : (allDisabled ? '已禁用' : '部分禁用')}
          </label>
        </div>
        {someDisabled && !allDisabled && (
          <div style={{ fontSize: 10, color: '#8a7e5e' }}>
            已禁用：{group.toolNames.filter(n => disabledTools.includes(n)).join(', ')}
          </div>
        )}
      </div>
    </div>
  )
}
