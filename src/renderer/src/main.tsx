import React from 'react'
import ReactDOM from 'react-dom/client'
import log from 'electron-log/renderer'
import App from './App'
import Settings from './pages/Settings'
import LogViewer from './pages/LogViewer'
import './App.css'

// 渲染进程日志同样写入同一文件
log.initialize()

// 根据 URL hash 判断渲染哪个页面
const hash = window.location.hash

function RootPage() {
  if (hash === '#/settings') return <Settings />
  if (hash === '#/logs') return <LogViewer />
  return <App />
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RootPage />
  </React.StrictMode>
)
