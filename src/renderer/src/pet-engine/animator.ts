/**
 * 通用桌宠动画状态机（数据驱动版）
 *
 * 每个状态的 startFrame / frameCount / fps / loop 从 ResolvedPetPack 读取，
 * 不再硬编码。对外保留与旧 CatAnimator 相似的 API（setState / start / stop / swapPack），
 * 方便业务代码无痛迁移。
 *
 * 每帧通过 FrameCallback 向渲染层推送当前帧信息：
 *   - sprite 模式：spriteOffsetX = 当前帧在 sprite sheet 上的偏移量（已含负号）
 *   - frames 模式：currentFrameUrl = 当前帧的 <img> src
 */

import type { CatState } from '@shared/types'
import { PET_CORE_STATES, type ResolvedPetPack, type ResolvedAnimation } from './types'

export interface FramePayload {
  /** 当前状态 */
  state: CatState
  /** 当前动画定义 */
  animation: ResolvedAnimation
  /** sprite 模式下 background-position 的 X 偏移（已带负号）；frames 模式下为 0 */
  spriteOffsetX: number
  /** frames 模式下当前帧 URL；sprite 模式下为 null */
  currentFrameUrl: string | null
}

export type FrameCallback = (payload: FramePayload) => void

/** 取动画总帧数（sprite/frames 两种模式统一接口） */
function getFrameCount(anim: ResolvedAnimation): number {
  return anim.type === 'sprite' ? anim.frameCount : anim.frameUrls.length
}

export class PetAnimator {
  private pack: ResolvedPetPack
  private state: CatState = 'idle'
  private currentFrame = 0
  private frameTimer = 0
  private rafId: number | null = null
  private lastTimestamp = 0
  private onFrame: FrameCallback

  constructor(pack: ResolvedPetPack, cb: FrameCallback) {
    this.pack = pack
    this.onFrame = cb
  }

  /**
   * 切换到指定状态；force=true 时即便相同状态也会重置帧计数
   * （用于"重新触发某个一次性动画"，如再次播 celebrate）。
   */
  setState(state: CatState, force = false): void {
    if (!PET_CORE_STATES.includes(state)) {
      console.warn('[PetAnimator] 未知状态，忽略:', state)
      return
    }
    if (this.state === state && !force) return
    this.state = state
    this.currentFrame = 0
    this.frameTimer = 0
  }

  getState(): CatState {
    return this.state
  }

  start(): void {
    this.lastTimestamp = performance.now()
    this.rafId = requestAnimationFrame(this.tick)
  }

  stop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
  }

  /**
   * 兼容旧 API：业务方有用户活跃时调用。
   * 4 态模型中没有"长 idle → sleep"逻辑，此处保留接口但 no-op。
   */
  notifyUserActive(): void {
    /* no-op */
  }

  /** 切换桌宠包（保留当前状态，重置帧） */
  swapPack(newPack: ResolvedPetPack): void {
    this.pack = newPack
    this.currentFrame = 0
    this.frameTimer = 0
    console.log('[PetAnimator] 切换桌宠包 →', newPack.id, '当前状态:', this.state)
  }

  /** 获取当前包的渲染尺寸（供渲染组件使用） */
  getDisplaySize(): { width: number; height: number; scale: number } {
    return {
      width: this.pack.frameW * this.pack.displayScale,
      height: this.pack.frameH * this.pack.displayScale,
      scale: this.pack.displayScale,
    }
  }

  private tick = (timestamp: number): void => {
    let dt = timestamp - this.lastTimestamp
    this.lastTimestamp = timestamp

    const anim = this.pack.animations[this.state]
    const total = getFrameCount(anim)
    const frameDuration = 1000 / anim.fps

    // 防止屏保/休眠恢复后 dt 过大导致帧疯狂快进：
    // 系统休眠时 rAF 暂停，恢复后首次回调的 dt 可能是数十秒甚至数分钟，
    // 如果直接累加到 frameTimer 会导致动画高速播放。
    // 将 dt 限制在 2 倍帧间隔内，确保每次 tick 最多前进 1 帧。
    if (dt > frameDuration * 2) {
      dt = frameDuration * 2
    }

    this.frameTimer += dt
    if (this.frameTimer >= frameDuration) {
      this.frameTimer -= frameDuration
      this.currentFrame++
      if (this.currentFrame >= total) {
        if (anim.loop) {
          this.currentFrame = 0
        } else {
          // 非循环动画播完 → 回 idle
          this.currentFrame = total - 1
          if (this.state !== 'idle') this.setState('idle')
        }
      }
    }

    this.emitFrame(anim)
    this.rafId = requestAnimationFrame(this.tick)
  }

  private emitFrame(anim: ResolvedAnimation): void {
    if (anim.type === 'sprite') {
      const absFrame = anim.startFrame + this.currentFrame
      const offsetX = -(absFrame * anim.frameW)
      this.onFrame({
        state: this.state,
        animation: anim,
        spriteOffsetX: offsetX,
        currentFrameUrl: null,
      })
    } else {
      const idx = Math.min(this.currentFrame, anim.frameUrls.length - 1)
      this.onFrame({
        state: this.state,
        animation: anim,
        spriteOffsetX: 0,
        currentFrameUrl: anim.frameUrls[idx],
      })
    }
  }
}
