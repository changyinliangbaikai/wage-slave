/**
 * 工具卡片组件
 */

import './ToolCard.css'

interface Tool {
  id: string
  name: string
  icon: string
  description: string
  disabled?: boolean
}

interface Props {
  tool: Tool
  onClick: () => void
}

export default function ToolCard({ tool, onClick }: Props) {
  return (
    <button
      className={`tool-card ${tool.disabled ? 'disabled' : ''}`}
      onClick={onClick}
      disabled={tool.disabled}
    >
      <span className="tool-icon">{tool.icon}</span>
      <span className="tool-name">{tool.name}</span>
      {tool.disabled && <span className="tool-badge">敬请期待</span>}
    </button>
  )
}

export type { Tool }
