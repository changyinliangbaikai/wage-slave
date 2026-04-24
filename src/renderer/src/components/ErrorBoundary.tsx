/**
 * 全局错误边界
 *
 * 捕获子组件树里抛出的错误，避免白屏；保留错误信息便于复制提交。
 * 主要用于包住整个页面根组件。
 */

import React from 'react'
import log from 'electron-log/renderer'

interface Props {
  children: React.ReactNode
  /** 可选的自定义 fallback 渲染器 */
  fallback?: (error: Error, reset: () => void) => React.ReactNode
}

interface State {
  error: Error | null
  info: React.ErrorInfo | null
}

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, info: null }

  static getDerivedStateFromError(error: Error): Partial<State> {
    // Render fallback UI on next render pass
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Persist to the shared electron-log file for postmortem
    log.error('[ErrorBoundary] 渲染异常:', error.message, error.stack, info.componentStack)
    this.setState({ info })
  }

  private reset = (): void => {
    this.setState({ error: null, info: null })
  }

  private handleCopy = (): void => {
    const { error, info } = this.state
    if (!error) return
    const text = [
      `Message: ${error.message}`,
      `Stack:\n${error.stack}`,
      info?.componentStack ? `ComponentStack:${info.componentStack}` : '',
    ]
      .filter(Boolean)
      .join('\n\n')
    navigator.clipboard.writeText(text).catch(() => {})
  }

  private handleReload = (): void => {
    window.location.reload()
  }

  render(): React.ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    if (this.props.fallback) return this.props.fallback(error, this.reset)

    return (
      <div
        style={{
          padding: '24px 28px',
          minHeight: '100vh',
          background: '#fdf6f1',
          color: '#2a2a2a',
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif",
          boxSizing: 'border-box',
        }}
      >
        <h2 style={{ marginTop: 0, color: '#b14a2a' }}>😿 页面渲染异常</h2>
        <p style={{ color: '#6b5a3d', lineHeight: 1.65 }}>
          小牛马也会摔跤。你可以：
        </p>
        <div style={{ display: 'flex', gap: 8, margin: '10px 0 18px' }}>
          <button onClick={this.reset} style={btnStyle}>🔄 重试渲染</button>
          <button onClick={this.handleReload} style={btnStyle}>♻️ 重载窗口</button>
          <button onClick={this.handleCopy} style={btnStyle}>📋 复制错误</button>
        </div>
        <details open style={detailsStyle}>
          <summary style={{ cursor: 'pointer', fontWeight: 600, color: '#8b5e3c' }}>
            错误详情
          </summary>
          <div style={{ marginTop: 10, fontFamily: 'SF Mono, Consolas, monospace', fontSize: 12 }}>
            <div style={{ color: '#b14a2a', marginBottom: 8 }}>{error.message}</div>
            <pre style={preStyle}>{error.stack}</pre>
            {this.state.info?.componentStack && (
              <>
                <div style={{ marginTop: 12, fontWeight: 600, color: '#8b5e3c' }}>
                  Component Stack
                </div>
                <pre style={preStyle}>{this.state.info.componentStack}</pre>
              </>
            )}
          </div>
        </details>
      </div>
    )
  }
}

const btnStyle: React.CSSProperties = {
  padding: '6px 14px',
  fontSize: 13,
  background: '#fff3cc',
  border: '1px solid #eadc9f',
  borderRadius: 6,
  cursor: 'pointer',
  color: '#6b5a3d',
  fontFamily: 'inherit',
}

const detailsStyle: React.CSSProperties = {
  background: '#fffef7',
  border: '1px solid #e5e0d1',
  borderRadius: 8,
  padding: '10px 14px',
}

const preStyle: React.CSSProperties = {
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  background: '#fdfaf0',
  padding: 10,
  borderRadius: 6,
  border: '1px solid #eee5cb',
  color: '#5a4a2a',
  overflowX: 'auto',
  margin: 0,
}
