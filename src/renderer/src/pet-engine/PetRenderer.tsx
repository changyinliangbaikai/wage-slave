/**
 * 桌宠渲染组件（数据驱动）
 *
 * 负责：
 *   - 启动时 loadActivePet() 拉取当前激活包并解析；
 *   - 持有 PetAnimator 驱动帧推进；
 *   - 监听 PETS_CHANGED 事件，激活包变更时热重载（不卸载组件、不丢业务状态）；
 *   - 同时支持 sprite 模式（background-position）和 frames 模式（<img> 切换）。
 *
 * 业务调用：
 *   <PetRenderer state={forceState} onAnimatorReady={a => animatorRef.current = a} />
 */

import { useEffect, useRef, useState } from 'react'
import type { CatState } from '@shared/types'
import { IPC } from '@shared/ipc-channels'
import { PetAnimator, type FramePayload } from './animator'
import { loadActivePet } from './loader'
import type { ResolvedPetPack } from './types'

interface ElectronAPI {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  on: (channel: string, listener: (...args: unknown[]) => void) => () => void
}
function getApi(): ElectronAPI | null {
  const w = window as unknown as { electronAPI?: ElectronAPI }
  return w.electronAPI ?? null
}

interface Props {
  /** 外部强制状态；undefined 时由 animator 自主管理（默认 idle） */
  state?: CatState
  /** animator 创建完成回调（供业务方持有引用做 setState） */
  onAnimatorReady?: (animator: PetAnimator) => void
  /** 额外样式（不会覆盖渲染必需的 width/height/backgroundImage 等） */
  className?: string
}

export default function PetRenderer({ state, onAnimatorReady, className }: Props) {
  const [pack, setPack] = useState<ResolvedPetPack | null>(null)
  const [frame, setFrame] = useState<FramePayload | null>(null)
  const animatorRef = useRef<PetAnimator | null>(null)

  // 初次加载 + 监听 PETS_CHANGED 热切换
  useEffect(() => {
    let cancelled = false

    const reload = async () => {
      try {
        const p = await loadActivePet()
        if (cancelled) return
        setPack(p)
      } catch (e) {
        console.error('[PetRenderer] 加载激活包失败:', e)
      }
    }

    reload()

    const api = getApi()
    const cleanup = api?.on(IPC.PETS_CHANGED, () => {
      console.log('[PetRenderer] 收到 PETS_CHANGED，重新加载激活包')
      reload()
    })

    return () => {
      cancelled = true
      cleanup?.()
    }
  }, [])

  // 把 onAnimatorReady 装到 ref 里，避免它的引用变化引起下面那个 effect 重跑、
  // 从而把正在跑的 animator stop 掉（这是之前热切换 pack 后桌宠卡死的根因之一）。
  const onAnimatorReadyRef = useRef(onAnimatorReady)
  useEffect(() => {
    onAnimatorReadyRef.current = onAnimatorReady
  }, [onAnimatorReady])

  // pack 就绪后启动 animator；若已有 animator，则做包热切换。
  // 关键：本 effect 故意不返回 cleanup —— pack 变化只调 swapPack 让 animator 平滑过渡，
  // 不能因为 deps 变化就 stop 当前 animator（否则下次 effect 会走 swap 分支但永远不再 start）。
  // animator 真正的 stop 由下面的 unmount-only effect 负责。
  useEffect(() => {
    if (!pack) return
    if (animatorRef.current) {
      animatorRef.current.swapPack(pack)
      return
    }
    const animator = new PetAnimator(pack, payload => setFrame(payload))
    animatorRef.current = animator
    animator.start()
    onAnimatorReadyRef.current?.(animator)
    console.log('[PetRenderer] animator 已创建并启动')
  }, [pack])

  // 仅在组件卸载时 stop animator，避免 deps 变化导致 animator 被误停
  useEffect(() => {
    return () => {
      animatorRef.current?.stop()
      animatorRef.current = null
      console.log('[PetRenderer] 组件卸载，animator 已停止')
    }
  }, [])

  // 外部强制状态
  useEffect(() => {
    if (state && animatorRef.current) {
      animatorRef.current.setState(state, true)
    }
  }, [state])

  if (!pack || !frame) {
    // 资源未就绪：留个空容器占位，避免布局抖动
    return <div className={className ?? 'pixel-cat'} aria-label="loading-pet" />
  }

  const displayW = pack.frameW * pack.displayScale
  const displayH = pack.frameH * pack.displayScale
  const cls = className ?? 'pixel-cat'

  // sprite 模式
  if (frame.animation.type === 'sprite') {
    const displayOffsetX = frame.spriteOffsetX * pack.displayScale
    return (
      <div
        className={cls}
        style={{
          width: displayW,
          height: displayH,
          backgroundImage: `url(${frame.animation.sourceUrl})`,
          backgroundPosition: `${displayOffsetX}px 0px`,
          backgroundSize: 'auto 100%',
          backgroundRepeat: 'no-repeat',
        }}
        data-state={frame.state}
        data-pet-id={pack.id}
      />
    )
  }

  // frames 模式：用 <img> 切换
  return (
    <div
      className={cls}
      style={{
        width: displayW,
        height: displayH,
        position: 'relative',
        backgroundRepeat: 'no-repeat',
      }}
      data-state={frame.state}
      data-pet-id={pack.id}
    >
      {frame.currentFrameUrl && (
        <img
          src={frame.currentFrameUrl}
          alt=""
          draggable={false}
          style={{
            width: displayW,
            height: displayH,
            display: 'block',
            imageRendering: 'pixelated',
            pointerEvents: 'none',
          }}
        />
      )}
    </div>
  )
}
