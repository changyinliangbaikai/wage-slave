/**
 * 小工具面板
 * 展示可用工具列表，点击进入具体工具
 */

import { useState } from 'react'
import ToolCard, { type Tool } from './ToolCard'
import SpellCheckPanel from './SpellCheck/SpellCheckPanel'
import SchedulerPanel from './Scheduler/SchedulerPanel'
import './ToolsPanel.css'

const TOOLS: Tool[] = [
  {
    id: 'spell-check',
    name: '错别字检查',
    icon: '✏️',
    description: '检查文本中的错别字',
  },
  {
    id: 'scheduler',
    name: '定时任务',
    icon: '⏰',
    description: '定时执行命令',
  },
  {
    id: 'format',
    name: '文本格式化',
    icon: '📝',
    description: '格式化文本内容',
    disabled: true,
  },
  {
    id: 'translate',
    name: '翻译工具',
    icon: '🌐',
    description: '文本翻译',
    disabled: true,
  },
]

interface Props {
  onClose?: () => void
}

export default function ToolsPanel({ onClose }: Props) {
  const [activeTool, setActiveTool] = useState<string | null>(null)

  const handleToolClick = (toolId: string) => {
    if (toolId === 'spell-check' || toolId === 'scheduler') {
      setActiveTool(toolId)
    }
    // 其他工具暂时不做处理
  }

  if (activeTool === 'spell-check') {
    return <SpellCheckPanel onBack={() => setActiveTool(null)} />
  }

  if (activeTool === 'scheduler') {
    return <SchedulerPanel onBack={() => setActiveTool(null)} />
  }

  return (
    <div className="tools-panel">
      <div className="panel-header">
        {onClose && <button className="btn-back" onClick={onClose}>← 返回</button>}
        <h3>🛠️ 小工具</h3>
      </div>

      <div className="tools-grid">
        {TOOLS.map((tool) => (
          <ToolCard
            key={tool.id}
            tool={tool}
            onClick={() => handleToolClick(tool.id)}
          />
        ))}
      </div>
    </div>
  )
}
