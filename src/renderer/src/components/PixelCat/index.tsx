import { useEffect, useRef, useState } from 'react'
import { CatAnimator, FRAME_W, FRAME_H } from './animator'
import type { CatState } from '@shared/types'
import spriteAll from '@assets/pixel_cat/sprite_all.png'
import './PixelCat.css'

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

  return (
    <div
      className="pixel-cat"
      style={{
        width: FRAME_W,
        height: FRAME_H,
        backgroundImage: `url(${spriteAll})`,
        backgroundPosition: `${offsetX}px 0px`,
        backgroundSize: 'auto 100%',
      }}
      data-state={currentState}
    />
  )
}
