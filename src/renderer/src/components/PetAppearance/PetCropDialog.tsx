/**
 * 桌宠 sprite 裁切弹窗
 *
 * 流程：
 *  1) 显示用户选的原图（任意尺寸），叠一个矩形裁切框 + 11 条等分辅助线
 *  2) 用户拖拽 4 个边手柄调整裁切框，让里面正好覆盖 12 帧
 *  3) 用户填名称/作者 → 「确认导入」
 *  4) 在内存 canvas 上裁切 → toBlob('image/png') → ArrayBuffer → IPC 发到主进程
 *
 * 设计权衡：
 *  - 不强制把裁切结果缩放到 1440×144；保留原始裁切像素，让 manifest.frame.width
 *    动态记录单帧尺寸，避免双重压缩损失画质。
 *  - 裁切宽度向内取整到 12 的倍数（floor），保证 12 帧整齐切片。
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
  width: number      // 原图实际像素宽
  height: number     // 原图实际像素高
  sizeBytes: number
  dataUrl: string    // base64 PNG，用于在 webSecurity 开启时安全预览
}

interface Props {
  picked: PickedFile
  onCancel: () => void
  /** 安装成功后回调（含新包 id），用于在父组件弹 toast + 刷新列表 */
  onInstalled: (id: string) => void
  /** 安装失败时调用，让父组件展示具体原因 toast */
  onError: (reason: string) => void
}

/** 单帧建议尺寸下限（避免帧太小看不清） */
const MIN_FRAME_SIZE = 16
/** 单帧建议尺寸上限（避免一帧上百 KB 影响内存） */
const MAX_FRAME_SIZE = 1024
/** 标准帧宽高比（120:144 = 5:6） */
const STD_FRAME_RATIO = 120 / 144
/** 标准 sprite 整图宽高比 = 12×120:144 = 10 */
const STD_SPRITE_RATIO = (120 * 12) / 144

type DragSide = 'top' | 'bottom' | 'left' | 'right' | null

/** 裁切矩形（原图像素坐标系） */
interface CropRect {
  x: number
  y: number
  w: number
  h: number
}

export default function PetCropDialog({ picked, onCancel, onInstalled, onError }: Props) {
  const imgRef = useRef<HTMLImageElement>(null)
  // 只记录显示宽，计算 scale；高度不需要独立 state（overlay 按原图像素 * scale 推导）
  const [imgDisplayW, setImgDisplayW] = useState(0)

  // 裁切框初始 = 整图
  const [crop, setCrop] = useState<CropRect>({
    x: 0, y: 0, w: picked.width, h: picked.height,
  })

  const [name, setName] = useState('')
  const [author, setAuthor] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // 显示坐标 ↔ 原图像素坐标 的缩放比
  const scale = imgDisplayW > 0 && picked.width > 0 ? imgDisplayW / picked.width : 1

  // ── 计算 <img> 显示尺寸 ────────────────────────
  // 让父容器（max-width 640 / max-height 320）等比包住原图
  useLayoutEffect(() => {
    const measure = () => {
      const img = imgRef.current
      if (!img) return
      const rect = img.getBoundingClientRect()
      setImgDisplayW(rect.width)
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [picked.dataUrl])

  // ── 拖拽逻辑 ──────────────────────────────
  const dragRef = useRef<{ side: DragSide; startX: number; startY: number; startCrop: CropRect }>({
    side: null, startX: 0, startY: 0, startCrop: crop,
  })

  const onHandleDown = useCallback((side: Exclude<DragSide, null>, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragRef.current = {
      side,
      startX: e.clientX,
      startY: e.clientY,
      startCrop: { ...crop },
    }
  }, [crop])

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current
      if (!d.side) return
      // 屏幕 → 原图像素：差值除以缩放比
      const dxPx = (e.clientX - d.startX) / scale
      const dyPx = (e.clientY - d.startY) / scale
      // 全量从 startCrop 推导新值（不依赖老 state）→ setCrop 只传常量，避免拖拽中 state 累加偏差
      let { x, y, w, h } = d.startCrop
      if (d.side === 'left') {
        const nx = clamp(x + dxPx, 0, x + w - MIN_FRAME_SIZE * 12)
        w = w - (nx - x)
        x = nx
      } else if (d.side === 'right') {
        w = clamp(w + dxPx, MIN_FRAME_SIZE * 12, picked.width - x)
      } else if (d.side === 'top') {
        const ny = clamp(y + dyPx, 0, y + h - MIN_FRAME_SIZE)
        h = h - (ny - y)
        y = ny
      } else if (d.side === 'bottom') {
        h = clamp(h + dyPx, MIN_FRAME_SIZE, picked.height - y)
      }
      setCrop({
        x: Math.round(x),
        y: Math.round(y),
        w: Math.round(w),
        h: Math.round(h),
      })
    }
    const onUp = () => { dragRef.current.side = null }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [scale, picked.width, picked.height])

  // ── 帧尺寸计算 ────────────────────────
  // 把宽度向下取整到 12 的倍数，保证整齐切片
  const frameWidth = Math.floor(crop.w / 12)
  const adjustedCropW = frameWidth * 12
  const frameHeight = crop.h

  // 自动算显示缩放（与主进程逻辑保持一致）
  const displayScalePreview = useMemo(() => {
    const v = 90 / frameWidth
    return Math.max(0.25, Math.min(2.0, Math.round(v * 100) / 100))
  }, [frameWidth])

  // 帧尺寸是否合理
  const frameSizeOk = frameWidth >= MIN_FRAME_SIZE && frameHeight >= MIN_FRAME_SIZE
    && frameWidth <= MAX_FRAME_SIZE && frameHeight <= MAX_FRAME_SIZE
  const ratioWarn = useMemo(() => {
    if (!frameSizeOk) return null
    const r = frameWidth / frameHeight
    const stdR = STD_FRAME_RATIO
    const diff = Math.abs(r - stdR) / stdR
    // 偏离 30% 以上提示用户
    if (diff > 0.3) {
      return `当前帧比例 ${r.toFixed(2)} 与推荐 ${stdR.toFixed(2)} 偏离较多`
    }
    return null
  }, [frameWidth, frameHeight, frameSizeOk])

  // ── 预设按钮 ─────────────────────────────
  /** 整图：覆盖整张原图 */
  const presetWhole = useCallback(() => {
    setCrop({ x: 0, y: 0, w: picked.width, h: picked.height })
  }, [picked.width, picked.height])

  /** 按图高度推算 13 帧的"理想横向带"：先按图高度算理想宽度，再尝试居中放置 */
  const presetByHeight = useCallback(() => {
    const idealW = Math.round(picked.height * STD_SPRITE_RATIO)
    if (idealW <= picked.width) {
      // 原图够宽：居中取理想宽度
      const x = Math.round((picked.width - idealW) / 2)
      setCrop({ x, y: 0, w: idealW, h: picked.height })
    } else {
      // 原图不够宽：以原图宽度为基准反推合适高度
      const idealH = Math.round(picked.width / STD_SPRITE_RATIO)
      const y = Math.round((picked.height - idealH) / 2)
      setCrop({ x: 0, y: y < 0 ? 0 : y, w: picked.width, h: Math.min(idealH, picked.height) })
    }
  }, [picked.width, picked.height])

  // ── 提交：canvas 裁切 → toBlob → ArrayBuffer → IPC ──
  const confirm = useCallback(async () => {
    if (submitting) return
    if (!name.trim()) {
      onError('请填写桌宠名称')
      return
    }
    if (!frameSizeOk) {
      onError(
        frameWidth < MIN_FRAME_SIZE || frameHeight < MIN_FRAME_SIZE
          ? '单帧太小（建议 ≥ 16×16）'
          : '单帧太大（单边 ≤ 1024）'
      )
      return
    }
    setSubmitting(true)
    try {
      console.log('[PetCrop] 开始裁切', { crop, adjustedCropW, frameWidth, frameHeight })
      // 把 dataUrl 加载到一个 detached <img>，避开 React 渲染影响
      const fullImg = await loadImage(picked.dataUrl)
      const canvas = document.createElement('canvas')
      canvas.width = adjustedCropW
      canvas.height = frameHeight
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        onError('当前浏览器环境不支持 canvas')
        setSubmitting(false)
        return
      }
      // 关闭 smoothing 保持像素感（特别是像素风桌宠）
      ctx.imageSmoothingEnabled = false
      ctx.drawImage(
        fullImg,
        crop.x, crop.y, adjustedCropW, frameHeight, // src
        0, 0, adjustedCropW, frameHeight,           // dst
      )

      const blob = await canvasToBlob(canvas, 'image/png')
      if (!blob) {
        onError('PNG 编码失败')
        setSubmitting(false)
        return
      }
      const arrBuf = await blob.arrayBuffer()
      console.log('[PetCrop] 裁切完成，提交字节', arrBuf.byteLength)

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
      console.error('[PetCrop] 裁切/提交失败:', e)
      onError(`未知错误：${(e as Error).message ?? String(e)}`)
    } finally {
      setSubmitting(false)
    }
  }, [
    submitting, name, author, frameSizeOk, frameWidth, frameHeight,
    crop, adjustedCropW, picked.dataUrl, onInstalled, onError,
  ])

  // 把裁切矩形换算成 overlay 在显示坐标系的 left/top/width/height
  const overlayStyle: CSSProperties = {
    left: `${crop.x * scale}px`,
    top: `${crop.y * scale}px`,
    width: `${crop.w * scale}px`,
    height: `${crop.h * scale}px`,
  }

  return (
    <div className="pet-crop-mask" onClick={() => !submitting && onCancel()}>
      <div className="pet-crop-modal" onClick={e => e.stopPropagation()}>
        <h3>裁切并导入桌宠</h3>

        <div className="pet-crop-hint">
          拖动 4 边的手柄调整框选区域，让里面 11 条竖线把 12 个动作帧均匀分开。
        </div>

        <div className="pet-crop-stage-wrap">
          {/* stage 留 padding 让 overlay 4 边外凸手柄落在 padding 区，避免被父级 overflow:auto 裁掉 */}
          <div className="pet-crop-stage">
            {/* img-wrap 是 overlay absolute 定位的参照系，原点严格 = img 左上 */}
            <div className="pet-crop-img-wrap">
              <img
                ref={imgRef}
                src={picked.dataUrl}
                className="pet-crop-img"
                alt="待裁切原图"
                draggable={false}
                onLoad={e => {
                  const rect = e.currentTarget.getBoundingClientRect()
                  setImgDisplayW(rect.width)
                }}
              />
              <div className="pet-crop-overlay" style={overlayStyle}>
              {/* 11 条等分辅助线（12 帧之间 11 道分割） */}
              {Array.from({ length: 11 }, (_, i) => (
                <div
                  key={i}
                  className="pet-crop-divider"
                  style={{ left: `${((i + 1) / 12) * 100}%` }}
                />
              ))}
              {/* 4 边手柄 */}
              <div className="pet-crop-handle pet-crop-handle-top" onMouseDown={e => onHandleDown('top', e)} />
              <div className="pet-crop-handle pet-crop-handle-bottom" onMouseDown={e => onHandleDown('bottom', e)} />
              <div className="pet-crop-handle pet-crop-handle-left" onMouseDown={e => onHandleDown('left', e)} />
              <div className="pet-crop-handle pet-crop-handle-right" onMouseDown={e => onHandleDown('right', e)} />
              </div>
            </div>
          </div>
        </div>

        <div className="pet-crop-stats">
          <div>
            <span className="pet-crop-stats-label">原图：</span>
            <span>{picked.width} × {picked.height}</span>
          </div>
          <div>
            <span className="pet-crop-stats-label">裁切：</span>
            <span className={frameSizeOk ? '' : 'pet-crop-stats-bad'}>
              {adjustedCropW} × {frameHeight}
            </span>
            <span className="pet-crop-stats-sub">
              （实际宽度向下取整到 13 的倍数）
            </span>
          </div>
          <div>
            <span className="pet-crop-stats-label">单帧：</span>
            <span className={frameSizeOk ? '' : 'pet-crop-stats-bad'}>
              {frameWidth} × {frameHeight}
            </span>
            <span className="pet-crop-stats-sub">
              · 显示缩放 ×{displayScalePreview.toFixed(2)}
            </span>
          </div>
          {ratioWarn && <div className="pet-crop-stats-warn">⚠ {ratioWarn}</div>}
        </div>

        <div className="pet-crop-presets">
          <button type="button" onClick={presetWhole} disabled={submitting}>
            🖼 整图
          </button>
          <button type="button" onClick={presetByHeight} disabled={submitting}>
            📐 按比例居中
          </button>
        </div>

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
          <label htmlFor="pet-crop-author">作者（可选）</label>
          <input
            id="pet-crop-author"
            type="text"
            value={author}
            onChange={e => setAuthor(e.target.value)}
            placeholder="你的名字"
            maxLength={48}
            disabled={submitting}
          />
        </div>

        <div className="pet-crop-actions">
          <button className="btn-test" onClick={onCancel} disabled={submitting}>取消</button>
          <button
            className="btn-save"
            onClick={confirm}
            disabled={submitting || !frameSizeOk || !name.trim()}
          >
            {submitting ? '导入中...' : '确认导入'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── 工具函数 ────────────────────────────────────

function clamp(v: number, min: number, max: number): number {
  if (max < min) return min
  return Math.max(min, Math.min(max, v))
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

/** 把主进程的英文 reason 翻成中文友好提示 */
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
