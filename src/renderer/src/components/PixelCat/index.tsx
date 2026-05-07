import { useEffect, useRef, useState } from 'react'
import { CatAnimator, FRAME_W, FRAME_H } from './animator'
import type { CatState } from '@shared/types'
import spriteAll from '@assets/pixel_cat/sprite_all.png'
import './PixelCat.css'

/**
 * 小猫显示缩放因子。
 * sprite 帧的实际像素尺寸为 120×144（FRAME_W × FRAME_H），
 * 此处按 DISPLAY_SCALE 等比缩小展示，仅影响视觉尺寸，
 * 不改变 animator 中的 sprite 切片逻辑（startFrame / offsetX 计算）。
 *
 * 注意：因 backgroundSize 设为 'auto 100%'，sprite 高度会自适应容器，
 * 宽度按原比例自动缩放，所以 backgroundPosition 偏移也要按同样比例缩放。
 */
const DISPLAY_SCALE = 0.75

interface Props {
  state?: CatState       // 外部强制状态（undefined = 由动画器自主管理）
  onAnimatorReady?: (animator: CatAnimator) => void
}

export default function PixelCat({ state, onAnimatorReady }: Props) {
  const [offsetX, setOffsetX] = useState(0)
  const [currentState, setCurrentState] = useState<CatState>('idle')
  const animatorRef = useRef<CatAnimator | null>(null)

  useEffect(() => {
    const animator = new CatAnimator((x, s) => {
      setOffsetX(x)
      setCurrentState(s)
    })
    animatorRef.current = animator
    animator.start()
    onAnimatorReady?.(animator)

    return () => animator.stop()
  }, [onAnimatorReady])

  // 外部传入 state 时强制切换
  useEffect(() => {
    if (state && animatorRef.current) {
      animatorRef.current.setState(state, true)
    }
  }, [state])

  // 按 DISPLAY_SCALE 缩放视觉尺寸与切帧偏移，保持 sprite 帧对齐
  const displayW = FRAME_W * DISPLAY_SCALE
  const displayH = FRAME_H * DISPLAY_SCALE
  const displayOffsetX = offsetX * DISPLAY_SCALE

  return (
    <div
      className="pixel-cat"
      style={{
        width: displayW,
        height: displayH,
        backgroundImage: `url(${spriteAll})`,
        backgroundPosition: `${displayOffsetX}px 0px`,
        backgroundSize: 'auto 100%',
      }}
      data-state={currentState}
    />
  )
}
