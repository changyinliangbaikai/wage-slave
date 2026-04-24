import React from 'react'
import ReactDOM from 'react-dom/client'
import log from 'electron-log/renderer'
import App from './App'
import Settings from './pages/Settings'
import LogViewer from './pages/LogViewer'
import ToolsPage from './pages/ToolsPage'
import AIChat from './pages/AIChat'
import ErrorBoundary from './components/ErrorBoundary'
import './App.css'

// 渲染进程日志同样写入同一文件
log.initialize()

// 全局兜底：未捕获的 Promise rejection 与同步异常
// 避免静默失败，统一写入日志文件便于事后排查
window.addEventListener('unhandledrejection', e => {
  log.error('[unhandledrejection]', e.reason?.message ?? String(e.reason), e.reason?.stack)
})
window.addEventListener('error', e => {
  log.error('[window.error]', e.message, e.filename, e.lineno, e.error?.stack)
})

// 根据 URL hash 判断渲染哪个页面
const hash = window.location.hash

function RootPage() {
  if (hash === '#/settings') return <Settings />
  if (hash === '#/logs') return <LogViewer />
  if (hash === '#/tools') return <ToolsPage />
  if (hash === '#/ai-chat') return <AIChat />
  return <App />
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <RootPage />
    </ErrorBoundary>
  </React.StrictMode>,
)
