/**
 * 小工具独立页面
 * 在独立窗口中渲染工具面板
 */

import { ToolsPanel } from '../components/Tools'
import './ToolsPage.css'

export default function ToolsPage() {
  return (
    <div className="tools-page">
      <ToolsPanel />
    </div>
  )
}
