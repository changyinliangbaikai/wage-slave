import { ReactNode } from 'react'
import './SpeechBubble.css'

interface Props {
  message: string
  children?: ReactNode          // 输入框、按钮等自定义内容
  visible: boolean
  onClose?: () => void
}

export default function SpeechBubble({ message, children, visible, onClose }: Props) {
  if (!visible) return null

  return (
    <div className="bubble-wrapper">
      <div className="bubble">
        {/* 关闭按钮 */}
        {onClose && (
          <button className="bubble-close" onClick={onClose} aria-label="关闭">×</button>
        )}

        {/* 消息文字 */}
        <p className="bubble-message">{message}</p>

        {/* 插槽：输入框、按钮组等 */}
        {children && <div className="bubble-content">{children}</div>}
      </div>

      {/* 气泡尾巴（指向猫咪方向） */}
      <div className="bubble-tail" />
    </div>
  )
}
