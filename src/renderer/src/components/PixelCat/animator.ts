/**
 * 像素猫动画状态机
 *
 * sprite_all.png 布局（横向排列，每帧 120×144px）：
 * idle(4) | blink(5) | talk(5) | happy(4) | worried(3) | stretch(4) | sleep(4)
 * 共 29 帧，总宽 3480px
 */

import type { CatState } from '@shared/types'

export const FRAME_W = 120
export const FRAME_H = 144

interface StateConfig {
  startFrame: number
  frameCount: number
  fps: number
  loop: boolean
}

export const STATE_CONFIG: Record<CatState, StateConfig> = {
  idle:    { startFrame: 0,  frameCount: 4, fps: 2,  loop: true  },
  blink:   { startFrame: 4,  frameCount: 5, fps: 8,  loop: false },
  talk:    { startFrame: 9,  frameCount: 5, fps: 6,  loop: true  },
  happy:   { startFrame: 14, frameCount: 4, fps: 5,  loop: true  },
  worried: { startFrame: 18, frameCount: 3, fps: 3,  loop: true  },
  stretch: { startFrame: 21, frameCount: 4, fps: 3,  loop: false },
  sleep:   { startFrame: 25, frameCount: 4, fps: 1,  loop: true  },
}

export class CatAnimator {
  private state: CatState = 'idle'
  private currentFrame = 0
  private frameTimer = 0
  private rafId: number | null = null
  private lastTimestamp = 0
  private onFrame: (offsetX: number, state: CatState) => void

  // 空闲时随机眨眼计时
  private nextBlinkIn = this.randomBlinkInterval()
  private blinkTimer = 0

  // 长时间无操作睡眠计时（10 分钟）
  private idleTimer = 0
  private readonly SLEEP_IDLE_MS = 10 * 60 * 1000

  constructor(cb: (offsetX: number, state: CatState) => void) {
    this.onFrame = cb
  }

  setState(state: CatState, force = false): void {
    if (this.state === state && !force) return

    // blink/stretch 播完自动回 idle
    const prev = this.state
    this.state = state
    this.currentFrame = 0
    this.frameTimer = 0

    // 切换回 idle 时重置眨眼计时
    if (state === 'idle') {
      this.nextBlinkIn = this.randomBlinkInterval()
      this.blinkTimer = 0
    }

    void prev  // suppress unused warning
  }

  getState(): CatState {
    return this.state
  }

  start(): void {
    this.lastTimestamp = performance.now()
    this.tick(this.lastTimestamp)
  }

  stop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
  }

  /** 通知动画器用户有输入（重置睡眠计时） */
  notifyUserActive(): void {
    this.idleTimer = 0
    if (this.state === 'sleep') {
      this.setState('idle')
    }
  }

  private tick = (timestamp: number): void => {
    const dt = timestamp - this.lastTimestamp
    this.lastTimestamp = timestamp

    const cfg = STATE_CONFIG[this.state]
    const frameDuration = 1000 / cfg.fps

    // 推进帧计时
    this.frameTimer += dt
    if (this.frameTimer >= frameDuration) {
      this.frameTimer -= frameDuration
      this.currentFrame++

      if (this.currentFrame >= cfg.frameCount) {
        if (cfg.loop) {
          this.currentFrame = 0
        } else {
          // 非循环动画播完，回到 idle
          this.currentFrame = cfg.frameCount - 1
          this.setState('idle')
        }
      }
    }

    // idle 状态下处理随机眨眼和睡眠
    if (this.state === 'idle') {
      this.blinkTimer += dt
      this.idleTimer += dt

      if (this.idleTimer >= this.SLEEP_IDLE_MS) {
        this.setState('sleep')
      } else if (this.blinkTimer >= this.nextBlinkIn) {
        this.blinkTimer = 0
        this.nextBlinkIn = this.randomBlinkInterval()
        this.setState('blink')
      }
    }

    // 计算当前帧在 sprite sheet 中的 X 偏移
    const absFrame = cfg.startFrame + this.currentFrame
    const offsetX = -(absFrame * FRAME_W)

    this.onFrame(offsetX, this.state)
    this.rafId = requestAnimationFrame(this.tick)
  }

  private randomBlinkInterval(): number {
    // 5~15 秒随机眨眼
    return (5 + Math.random() * 10) * 1000
  }
}
