/**
 * 桌宠 sprite 裁切弹窗（整体优化版）
 *
 * 核心改进：
 *  - 暗罩聚焦：裁切框外加半透明蒙版，视线立刻落在选区上
 *  - 8 手柄（4 边 + 4 角）：业界标准的图像编辑交互
 *  - 暗罩区拖框创建：mousedown + drag 直接画新框，单击则恢复
 *  - 12 帧实时预览条：底部缩略图所见即所得，提交前就能验证「切对没」
 *  - 辅助线带圆点手柄 + hover 实化：更直观、更精确
 *  - 默认按高度推算 12 帧区：开局就接近正确
 *  - 快捷键：ESC 取消、⌘/Ctrl+Enter 确认
 *
 * 提交流程：用户调好裁切框 + 11 条辅助线 → canvas 逐段裁切并独立缩放到「平均帧宽」
 *           → 拼成等宽 12 帧 sprite → toBlob → ArrayBuffer → IPC 发到主进程
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import { IPC } from '@shared/ipc-channels'
import './PetCropDialog.css'

interface ElectronAPI {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
}
const api = (window as unknown as { electronAPI: ElectronAPI }).electronAPI

type InstallResult = { ok: true; id: string } | { ok: false; reason: string }

interface PickedFile {
  filePath: string
  width: number
  height: number
  sizeBytes: number
  dataUrl: string
}

interface Props {
  picked: PickedFile
  onCancel: () => void
  onInstalled: (id: string) => void
  onError: (reason: string) => void
}

// ── 常量 ─────────────────────────
/** 单帧最小尺寸（避免帧太小看不清） */
const MIN_FRAME_SIZE = 16
/** 单帧最大尺寸（避免内存爆炸） */
const MAX_FRAME_SIZE = 1024
/** 标准单帧宽高比 120:144 */
const STD_FRAME_RATIO = 120 / 144
/** 标准 12 帧整图宽高比 = 1440:144 = 10 */
const STD_SPRITE_RATIO = (120 * 12) / 144

/** 8 个方位手柄 */
type EdgeSide = 'top' | 'bottom' | 'left' | 'right' | 'tl' | 'tr' | 'bl' | 'br'

/** 拖拽对象 */
type DragMode =
  | { kind: 'edge'; side: EdgeSide }
  | { kind: 'divider'; index: number }
  | { kind: 'create' }
  | null

/** 显示缩放档位 */
type ViewScale = 'fit' | 0.5 | 1 | 2 | 3
const ZOOM_OPTIONS: readonly ViewScale[] = ['fit', 0.5, 1, 2, 3] as const

interface CropRect {
  x: number
  y: number
  w: number
  h: number
}

/** 按图高度推算 12 帧理想区域（开局默认裁切） */
function computeDefaultCrop(width: number, height: number): CropRect {
  const idealW = Math.round(height * STD_SPRITE_RATIO)
  if (idealW <= width) {
    const x = Math.round((width - idealW) / 2)
    return { x, y: 0, w: idealW, h: height }
  }
  const idealH = Math.round(width / STD_SPRITE_RATIO)
  const y = Math.max(0, Math.round((height - idealH) / 2))
  return { x: 0, y, w: width, h: Math.min(idealH, height) }
}

export default function PetCropDialog({ picked, onCancel, onInstalled, onError }: Props) {
  const imgRef = useRef<HTMLImageElement>(null)
  const imgWrapRef = useRef<HTMLDivElement>(null)
  /** 全尺寸 Image 缓存，提交 + 预览复用，避免重复 decode */
  const fullImgRef = useRef<HTMLImageElement | null>(null)
  /** fullImg 加载版本计数：递增即「fullImg 就绪」信号，用作预览 effect 的依赖 */
  const [fullImgVersion, setFullImgVersion] = useState(0)

  const [viewScale, setViewScale] = useState<ViewScale>('fit')
  const [fitMeasuredW, setFitMeasuredW] = useState(0)

  // 默认裁切 = 按图高度智能推算 12 帧区域（替代「默认整图」）
  const [crop, setCrop] = useState<CropRect>(() => computeDefaultCrop(picked.width, picked.height))

  // 11 条辅助线占比（递增的 0~1）；初始均匀分布
  const [dividerRatios, setDividerRatios] = useState<number[]>(makeUniformRatios)

  const [name, setName] = useState('')
  const [author, setAuthor] = useState('')
  const [submitting, setSubmitting] = useState(false)

  /** 12 帧预览缩略图（每帧一张 dataURL）；未就绪时为空数组 */
  const [framePreviews, setFramePreviews] = useState<string[]>([])

  // 显示坐标 ↔ 原图像素 缩放比
  const imgDisplayW = viewScale === 'fit' ? fitMeasuredW : picked.width * viewScale
  const scale = imgDisplayW > 0 && picked.width > 0 ? imgDisplayW / picked.width : 1

  // ── 实测显示宽（仅 fit 模式）────────
  useLayoutEffect(() => {
    if (viewScale !== 'fit') return
    const measure = () => {
      const img = imgRef.current
      if (!img) return
      setFitMeasuredW(img.getBoundingClientRect().width)
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [picked.dataUrl, viewScale])

  // ── 缓存 fullImg（用于预览 + 提交时复用，避免每次 loadImage）──
  useEffect(() => {
    let cancelled = false
    fullImgRef.current = null
    loadImage(picked.dataUrl)
      .then(img => {
        if (!cancelled) {
          fullImgRef.current = img
          // 递增版本号 → 预览 effect 依赖它 → 触发首次预览渲染
          setFullImgVersion(v => v + 1)
          console.log('[PetCrop] fullImg loaded', img.width, img.height)
        }
      })
      .catch(e => console.warn('[PetCrop] fullImg 加载失败', e))
    return () => {
      cancelled = true
    }
  }, [picked.dataUrl])

  // ── 拖拽逻辑 ────────────────────
  const dragRef = useRef<{
    mode: DragMode
    startX: number
    startY: number
    startCrop: CropRect
    startRatios: number[]
    /** create 模式专用：保存创建前的 crop，单击未拖时恢复 */
    prevCrop?: CropRect
  }>({
    mode: null,
    startX: 0,
    startY: 0,
    startCrop: { x: 0, y: 0, w: 0, h: 0 },
    startRatios: [],
  })

  /** 边/角手柄按下 */
  const onHandleDown = useCallback(
    (side: EdgeSide, e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      dragRef.current = {
        mode: { kind: 'edge', side },
        startX: e.clientX,
        startY: e.clientY,
        startCrop: { ...crop },
        startRatios: dividerRatios,
      }
    },
    [crop, dividerRatios],
  )

  /** 辅助线按下 */
  const onDividerDown = useCallback(
    (index: number, e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      dragRef.current = {
        mode: { kind: 'divider', index },
        startX: e.clientX,
        startY: e.clientY,
        startCrop: { ...crop },
        startRatios: [...dividerRatios],
      }
    },
    [crop, dividerRatios],
  )

  /** 暗罩 mousedown：在图任意空白位置直接拖出新裁切框 */
  const onCreateDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const wrap = imgWrapRef.current
      if (!wrap || scale <= 0) return
      const rect = wrap.getBoundingClientRect()
      const ox = clamp((e.clientX - rect.left) / scale, 0, picked.width)
      const oy = clamp((e.clientY - rect.top) / scale, 0, picked.height)
      dragRef.current = {
        mode: { kind: 'create' },
        startX: e.clientX,
        startY: e.clientY,
        startCrop: { x: ox, y: oy, w: 0, h: 0 },
        startRatios: dividerRatios,
        prevCrop: crop,
      }
      // 起步置 0 尺寸框；onMove 会扩张
      setCrop({ x: Math.round(ox), y: Math.round(oy), w: 0, h: 0 })
    },
    [scale, picked.width, picked.height, crop, dividerRatios],
  )

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current
      if (!d.mode) return
      const dxPx = (e.clientX - d.startX) / scale
      const dyPx = (e.clientY - d.startY) / scale

      if (d.mode.kind === 'edge') {
        const side = d.mode.side
        let { x, y, w, h } = d.startCrop
        // 水平分量：left/tl/bl 同时改 x 与 w；right/tr/br 只改 w
        if (side === 'left' || side === 'tl' || side === 'bl') {
          const nx = clamp(x + dxPx, 0, x + w - MIN_FRAME_SIZE * 12)
          w = w - (nx - x)
          x = nx
        } else if (side === 'right' || side === 'tr' || side === 'br') {
          w = clamp(w + dxPx, MIN_FRAME_SIZE * 12, picked.width - x)
        }
        // 垂直分量：top/tl/tr 同时改 y 与 h；bottom/bl/br 只改 h
        if (side === 'top' || side === 'tl' || side === 'tr') {
          const ny = clamp(y + dyPx, 0, y + h - MIN_FRAME_SIZE)
          h = h - (ny - y)
          y = ny
        } else if (side === 'bottom' || side === 'bl' || side === 'br') {
          h = clamp(h + dyPx, MIN_FRAME_SIZE, picked.height - y)
        }
        setCrop({
          x: Math.round(x),
          y: Math.round(y),
          w: Math.round(w),
          h: Math.round(h),
        })
      } else if (d.mode.kind === 'divider') {
        const idx = d.mode.index
        const cropW = d.startCrop.w
        if (cropW <= 0) return
        const minGap = MIN_FRAME_SIZE / cropW
        const leftBound = idx === 0 ? minGap : d.startRatios[idx - 1] + minGap
        const rightBound =
          idx === d.startRatios.length - 1 ? 1 - minGap : d.startRatios[idx + 1] - minGap
        const newR = clamp(d.startRatios[idx] + dxPx / cropW, leftBound, rightBound)
        const next = [...d.startRatios]
        next[idx] = newR
        setDividerRatios(next)
      } else if (d.mode.kind === 'create') {
        // d.startCrop.x / y 是创建起点（原图坐标）
        const ox = d.startCrop.x
        const oy = d.startCrop.y
        const curX = clamp(ox + dxPx, 0, picked.width)
        const curY = clamp(oy + dyPx, 0, picked.height)
        setCrop({
          x: Math.round(Math.min(ox, curX)),
          y: Math.round(Math.min(oy, curY)),
          w: Math.round(Math.abs(curX - ox)),
          h: Math.round(Math.abs(curY - oy)),
        })
      }
    }
    const onUp = () => {
      const d = dragRef.current
      // 拖框创建：尺寸太小（用户只是单击没拖）→ 恢复创建前的 crop
      if (d.mode?.kind === 'create' && d.prevCrop) {
        const restore = d.prevCrop
        setCrop(prev => {
          if (prev.w < MIN_FRAME_SIZE * 12 || prev.h < MIN_FRAME_SIZE) {
            return restore
          }
          return prev
        })
      }
      d.mode = null
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [scale, picked.width, picked.height])

  // ── 帧尺寸计算 ────────────────────
  const frameSegments = useMemo<number[]>(() => {
    const widths: number[] = []
    const cropW = crop.w
    let prev = 0
    for (let i = 0; i < 12; i++) {
      const cur = i === 11 ? 1 : dividerRatios[i]
      widths.push(Math.max(0, (cur - prev) * cropW))
      prev = cur
    }
    return widths
  }, [crop.w, dividerRatios])

  const minFrameW = Math.min(...frameSegments)
  const maxFrameW = Math.max(...frameSegments)
  const avgFrameW = frameSegments.reduce((a, b) => a + b, 0) / 12
  const frameWidth = Math.max(1, Math.floor(avgFrameW))
  const frameHeight = crop.h
  const isUneven = maxFrameW - minFrameW > 1

  const displayScalePreview = useMemo(() => {
    const v = 90 / frameWidth
    return Math.max(0.25, Math.min(2.0, Math.round(v * 100) / 100))
  }, [frameWidth])

  const frameSizeOk =
    minFrameW >= MIN_FRAME_SIZE &&
    frameHeight >= MIN_FRAME_SIZE &&
    maxFrameW <= MAX_FRAME_SIZE &&
    frameHeight <= MAX_FRAME_SIZE

  const ratioWarn = useMemo(() => {
    if (!frameSizeOk) return null
    const r = avgFrameW / frameHeight
    const stdR = STD_FRAME_RATIO
    const diff = Math.abs(r - stdR) / stdR
    if (diff > 0.3) {
      return `平均帧比例 ${r.toFixed(2)} 与推荐 ${stdR.toFixed(2)} 偏离较多`
    }
    return null
  }, [avgFrameW, frameHeight, frameSizeOk])

  // ── 12 帧实时预览（节流 80ms，避免拖拽频繁渲染）──
  // 不在 effect 同步路径里调 setState；frameSizeOk false 时用 derived state 直接屏蔽展示
  useEffect(() => {
    if (!frameSizeOk) return
    const timer = setTimeout(() => {
      const fullImg = fullImgRef.current
      if (!fullImg) return
      const PREVIEW_H = 56
      const PREVIEW_W = Math.max(
        8,
        Math.min(180, Math.round((PREVIEW_H * frameWidth) / frameHeight)),
      )
      const urls: string[] = []
      let cumX = crop.x
      for (let i = 0; i < 12; i++) {
        const segW = frameSegments[i]
        const c = document.createElement('canvas')
        c.width = PREVIEW_W
        c.height = PREVIEW_H
        const ctx = c.getContext('2d')
        if (!ctx) {
          urls.push('')
          cumX += segW
          continue
        }
        ctx.imageSmoothingEnabled = false
        if (segW > 0 && crop.h > 0) {
          ctx.drawImage(fullImg, cumX, crop.y, segW, crop.h, 0, 0, PREVIEW_W, PREVIEW_H)
        }
        urls.push(c.toDataURL('image/png'))
        cumX += segW
      }
      setFramePreviews(urls)
    }, 80)
    return () => clearTimeout(timer)
    // fullImgVersion 是 fullImg 加载完成的"信号"，首次加载完会触发预览
  }, [fullImgVersion, crop, frameSegments, frameSizeOk, frameWidth, frameHeight])

  // ── 预设 ────────────────────────
  const presetWhole = useCallback(() => {
    setCrop({ x: 0, y: 0, w: picked.width, h: picked.height })
  }, [picked.width, picked.height])

  const resetDividers = useCallback(() => {
    setDividerRatios(makeUniformRatios())
  }, [])

  const presetByHeight = useCallback(() => {
    setCrop(computeDefaultCrop(picked.width, picked.height))
  }, [picked.width, picked.height])

  // ── 提交 ────────────────────────
  const confirm = useCallback(async () => {
    if (submitting) return
    if (!name.trim()) {
      onError('请填写桌宠名称')
      return
    }
    if (!frameSizeOk) {
      const tooSmall = minFrameW < MIN_FRAME_SIZE || frameHeight < MIN_FRAME_SIZE
      onError(tooSmall ? '单帧太小（建议 ≥ 16×16）' : '单帧太大（单边 ≤ 1024）')
      return
    }
    setSubmitting(true)
    try {
      console.log('[PetCrop] 提交', { crop, frameSegments, frameWidth, frameHeight, isUneven })
      const fullImg = fullImgRef.current ?? (await loadImage(picked.dataUrl))
      const canvas = document.createElement('canvas')
      canvas.width = frameWidth * 12
      canvas.height = frameHeight
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        onError('当前浏览器环境不支持 canvas')
        setSubmitting(false)
        return
      }
      ctx.imageSmoothingEnabled = false
      let cumX = crop.x
      for (let i = 0; i < 12; i++) {
        const segW = frameSegments[i]
        ctx.drawImage(
          fullImg,
          cumX,
          crop.y,
          segW,
          crop.h,
          i * frameWidth,
          0,
          frameWidth,
          crop.h,
        )
        cumX += segW
      }

      const blob = await canvasToBlob(canvas, 'image/png')
      if (!blob) {
        onError('PNG 编码失败')
        setSubmitting(false)
        return
      }
      const arrBuf = await blob.arrayBuffer()
      console.log('[PetCrop] 提交字节', arrBuf.byteLength)

      const result = (await api.invoke(IPC.PETS_INSTALL_SPRITE_BYTES, {
        name: name.trim(),
        author: author.trim() || undefined,
        bytes: arrBuf,
        frameWidth,
        frameHeight,
      })) as InstallResult

      if (result.ok) {
        onInstalled(result.id)
      } else {
        onError(translateInstallReason(result.reason))
      }
    } catch (e) {
      console.error('[PetCrop] 提交失败', e)
      onError(`未知错误：${(e as Error).message ?? String(e)}`)
    } finally {
      setSubmitting(false)
    }
  }, [
    submitting,
    name,
    author,
    frameSizeOk,
    frameWidth,
    frameHeight,
    minFrameW,
    crop,
    frameSegments,
    isUneven,
    picked.dataUrl,
    onInstalled,
    onError,
  ])

  // ── 快捷键：ESC 取消 / ⌘Enter 确认 ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (submitting) return
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        if (frameSizeOk && name.trim()) confirm()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [submitting, frameSizeOk, name, onCancel, confirm])

  // ── 几何换算 ────────────────────
  const overlayStyle: CSSProperties = {
    left: `${crop.x * scale}px`,
    top: `${crop.y * scale}px`,
    width: `${crop.w * scale}px`,
    height: `${crop.h * scale}px`,
  }

  /** 4 块暗罩：覆盖裁切框外的「上/下/左/右」4 个矩形区域；本身可点击触发拖框创建 */
  const shadeRects = useMemo<CSSProperties[]>(() => {
    const dx = crop.x * scale
    const dy = crop.y * scale
    const dw = crop.w * scale
    const dh = crop.h * scale
    const totalW = picked.width * scale
    const totalH = picked.height * scale
    return [
      // 上
      { left: 0, top: 0, width: totalW, height: dy },
      // 下
      { left: 0, top: dy + dh, width: totalW, height: Math.max(0, totalH - dy - dh) },
      // 左
      { left: 0, top: dy, width: dx, height: dh },
      // 右
      { left: dx + dw, top: dy, width: Math.max(0, totalW - dx - dw), height: dh },
    ]
  }, [crop, scale, picked.width, picked.height])

  const canConfirm = !submitting && frameSizeOk && name.trim().length > 0
  // derived：帧尺寸非法时直接屏蔽预览（避免显示陈旧缩略图给用户误导）
  const displayedPreviews = frameSizeOk ? framePreviews : []

  return (
    <div className="pet-crop-mask" onClick={() => !submitting && onCancel()}>
      <div className="pet-crop-modal" onClick={e => e.stopPropagation()}>
        {/* 1. 头部 */}
        <header className="pet-crop-header">
          <h3>裁切并导入桌宠</h3>
          <button
            className="pet-crop-close"
            onClick={onCancel}
            disabled={submitting}
            title="取消（ESC）"
          >
            ×
          </button>
        </header>

        {/* 2. 工具栏：缩放 + 预设 */}
        <div className="pet-crop-toolbar">
          <div className="pet-crop-toolbar-group">
            <span className="pet-crop-toolbar-label">显示</span>
            {ZOOM_OPTIONS.map(opt => (
              <button
                key={String(opt)}
                type="button"
                className={`pet-crop-zoom-btn${
                  viewScale === opt ? ' pet-crop-zoom-btn-active' : ''
                }`}
                onClick={() => setViewScale(opt)}
                disabled={submitting}
              >
                {opt === 'fit' ? '适配' : `${opt}×`}
              </button>
            ))}
          </div>
          <div className="pet-crop-toolbar-spacer" />
          <div className="pet-crop-toolbar-group">
            <button
              type="button"
              className="pet-crop-tool-btn"
              onClick={presetByHeight}
              disabled={submitting}
              title="按图高度自动推算 12 帧区域"
            >
              📐 智能框选
            </button>
            <button
              type="button"
              className="pet-crop-tool-btn"
              onClick={presetWhole}
              disabled={submitting}
            >
              🖼 整图
            </button>
            <button
              type="button"
              className="pet-crop-tool-btn"
              onClick={resetDividers}
              disabled={submitting}
              title="11 条辅助线恢复均匀分布"
            >
              ⇺ 辅助线均分
            </button>
          </div>
        </div>

        {/* 3. 操作提示行 */}
        <div className="pet-crop-hint">
          <span>
            <kbd>拖暗区</kbd>画新框
          </span>
          <span>
            <kbd>拖角/边</kbd>调大小
          </span>
          <span>
            <kbd>拖竖线</kbd>对齐每帧
          </span>
          <span className="pet-crop-hint-extra">不等宽时会自动缩到平均帧宽</span>
        </div>

        {/* 4. 主舞台 */}
        <div className="pet-crop-stage-wrap">
          <div className="pet-crop-stage">
            <div className="pet-crop-img-wrap" ref={imgWrapRef}>
              <img
                ref={imgRef}
                src={picked.dataUrl}
                className="pet-crop-img"
                alt="待裁切原图"
                draggable={false}
                style={
                  typeof viewScale === 'number'
                    ? {
                        width: picked.width * viewScale,
                        height: picked.height * viewScale,
                        maxWidth: 'none',
                        maxHeight: 'none',
                      }
                    : undefined
                }
                onLoad={e => {
                  if (viewScale === 'fit') {
                    setFitMeasuredW(e.currentTarget.getBoundingClientRect().width)
                  }
                }}
              />

              {/* 4 块暗罩：裁切框外的半透明区域，本身可点击触发 create 拖框 */}
              {scale > 0 &&
                shadeRects.map((s, i) => (
                  <div
                    key={i}
                    className="pet-crop-shade"
                    style={s}
                    onMouseDown={onCreateDown}
                  />
                ))}

              {/* 裁切框 */}
              <div
                className="pet-crop-overlay"
                style={overlayStyle}
                onMouseDown={e => e.stopPropagation()}
              >
                {/* 11 条辅助线（每条都带顶部圆点手柄） */}
                {dividerRatios.map((r, i) => (
                  <div
                    key={i}
                    className="pet-crop-divider"
                    style={{ left: `${r * 100}%` }}
                    onMouseDown={e => onDividerDown(i, e)}
                    title={`帧 ${i + 1} ↔ 帧 ${i + 2}`}
                  >
                    <span className="pet-crop-divider-knob" />
                  </div>
                ))}

                {/* 8 手柄：4 边长条（hover 才染色）+ 4 角实心方块 */}
                <div
                  className="pet-crop-handle pet-crop-handle-t"
                  onMouseDown={e => onHandleDown('top', e)}
                />
                <div
                  className="pet-crop-handle pet-crop-handle-b"
                  onMouseDown={e => onHandleDown('bottom', e)}
                />
                <div
                  className="pet-crop-handle pet-crop-handle-l"
                  onMouseDown={e => onHandleDown('left', e)}
                />
                <div
                  className="pet-crop-handle pet-crop-handle-r"
                  onMouseDown={e => onHandleDown('right', e)}
                />
                <div
                  className="pet-crop-handle pet-crop-corner pet-crop-handle-tl"
                  onMouseDown={e => onHandleDown('tl', e)}
                />
                <div
                  className="pet-crop-handle pet-crop-corner pet-crop-handle-tr"
                  onMouseDown={e => onHandleDown('tr', e)}
                />
                <div
                  className="pet-crop-handle pet-crop-corner pet-crop-handle-bl"
                  onMouseDown={e => onHandleDown('bl', e)}
                />
                <div
                  className="pet-crop-handle pet-crop-corner pet-crop-handle-br"
                  onMouseDown={e => onHandleDown('br', e)}
                />
              </div>
            </div>
          </div>
        </div>

        {/* 5. 12 帧预览条 + 状态信息 */}
        <div className="pet-crop-preview">
          <div className="pet-crop-preview-label">
            <span>12 帧预览</span>
            <span className="pet-crop-preview-sub">所见即所得</span>
            {!frameSizeOk && (
              <span className="pet-crop-stats-warn">· 帧尺寸异常，请调整裁切框</span>
            )}
            {ratioWarn && <span className="pet-crop-stats-warn">· {ratioWarn}</span>}
          </div>
          <div className="pet-crop-preview-strip">
            {displayedPreviews.length === 12
              ? displayedPreviews.map((url, i) => (
                  <div
                    key={i}
                    className="pet-crop-preview-frame"
                    title={`帧 ${i + 1} · 源宽 ${Math.round(frameSegments[i])}px`}
                  >
                    <img src={url} alt={`帧 ${i + 1}`} draggable={false} />
                    <span className="pet-crop-preview-num">{i + 1}</span>
                  </div>
                ))
              : Array.from({ length: 12 }, (_, i) => (
                  <div
                    key={i}
                    className="pet-crop-preview-frame pet-crop-preview-frame-empty"
                  >
                    <span className="pet-crop-preview-num">{i + 1}</span>
                  </div>
                ))}
          </div>
          <div className="pet-crop-stats-bar">
            <span>
              原图 <strong>{picked.width}×{picked.height}</strong>
            </span>
            <span className="pet-crop-stats-dot">·</span>
            <span>
              裁切 <strong>{Math.round(crop.w)}×{frameHeight}</strong>
            </span>
            <span className="pet-crop-stats-dot">·</span>
            <span>
              单帧{' '}
              <strong className={frameSizeOk ? '' : 'pet-crop-stats-bad'}>
                {frameWidth}×{frameHeight}
              </strong>
            </span>
            <span className="pet-crop-stats-sub">渲染 ×{displayScalePreview.toFixed(2)}</span>
            {isUneven && (
              <span className="pet-crop-stats-warn">
                不等宽 {Math.floor(minFrameW)}~{Math.ceil(maxFrameW)}px
              </span>
            )}
          </div>
        </div>

        {/* 6. 表单 */}
        <div className="pet-crop-form">
          <div className="pet-crop-form-row">
            <label htmlFor="pet-crop-name">桌宠名称 *</label>
            <input
              id="pet-crop-name"
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="给你的桌宠起个名字"
              maxLength={48}
              autoFocus
              disabled={submitting}
            />
          </div>
          <div className="pet-crop-form-row">
            <label htmlFor="pet-crop-author">作者</label>
            <input
              id="pet-crop-author"
              type="text"
              value={author}
              onChange={e => setAuthor(e.target.value)}
              placeholder="可选"
              maxLength={48}
              disabled={submitting}
            />
          </div>
        </div>

        {/* 7. 底部操作 */}
        <div className="pet-crop-actions">
          <span className="pet-crop-actions-tip">
            <kbd>ESC</kbd> 取消 · <kbd>⌘/Ctrl + ↵</kbd> 确认
          </span>
          <div className="pet-crop-actions-btns">
            <button className="btn-test" onClick={onCancel} disabled={submitting}>
              取消
            </button>
            <button className="btn-save" onClick={confirm} disabled={!canConfirm}>
              {submitting ? '导入中...' : '确认导入'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── 工具函数 ────────────────────

function clamp(v: number, min: number, max: number): number {
  if (max < min) return min
  return Math.max(min, Math.min(max, v))
}

function makeUniformRatios(): number[] {
  return Array.from({ length: 11 }, (_, i) => (i + 1) / 12)
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = e => reject(new Error(`Image load failed: ${e}`))
    img.src = src
  })
}

function canvasToBlob(canvas: HTMLCanvasElement, mime: string): Promise<Blob | null> {
  return new Promise(resolve => canvas.toBlob(b => resolve(b), mime))
}

/** 主进程英文 reason → 中文友好提示 */
function translateInstallReason(reason: string): string {
  const map: Record<string, string> = {
    'name-required': '请填写桌宠名称',
    'invalid-bytes': 'PNG 字节不合法',
    'too-large': '生成的 PNG 过大（请缩小裁切范围）',
    'not-png': 'PNG 编码失败',
    'frame-size-invalid': '单帧尺寸不合法',
    'frame-too-small': '单帧太小，请扩大裁切范围',
    'frame-too-large': '单帧太大，请减小裁切范围',
    'id-collision': '名称冲突，请改一个',
    'write-failed': '写入失败，请检查磁盘权限',
  }
  return map[reason] ?? `导入失败：${reason}`
}
