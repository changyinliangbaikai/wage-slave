import { useEffect, useRef, useState } from 'react'
import type { AgentSecurityPolicy, AgentToolGroupMeta, AppConfig } from '@shared/types'

interface AgentSettingsProps {
  config: AppConfig
  toolGroups: AgentToolGroupMeta[]
  securityPolicy: AgentSecurityPolicy | null
  onChange: (patch: Partial<AppConfig>) => void
}

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

  return (
    <>
      <section className="settings-section">
        <h2>Agent 专用模型（可选）</h2>
        <p style={{ fontSize: 12, color: '#8a7e5e', marginBottom: 12 }}>
          如果不填写，Agent 会使用上方主聊天的模型配置。建议优先选择支持 tool_calls 的模型；不支持时会自动降级为文本工具协议。
        </p>
        <div className="field-row">
          <label>API 地址</label>
          <input
            type="text"
            value={config.agent_llm_api_url ?? ''}
            onChange={e => onChange({ agent_llm_api_url: e.target.value })}
            placeholder="留空则使用主聊天配置"
          />
        </div>
        <div className="field-row">
          <label>模型名称</label>
          <input
            type="text"
            value={config.agent_llm_model ?? ''}
            onChange={e => onChange({ agent_llm_model: e.target.value })}
            placeholder="留空则使用主聊天配置"
          />
        </div>
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
