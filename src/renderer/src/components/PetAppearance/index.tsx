/**
 * 桌宠外观面板（设置页用）
 *
 * 职责：
 *  - 列出已安装桌宠包，点击切换激活；用户包可删除
 *  - 上传 sprite sheet 创建新包（主入口）
 *  - 折叠的高级操作：导入 .zip / 打开桌宠目录
 *  - AI 生图提示词卡片（风格关键词 + 一键复制）
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { IPC } from '@shared/ipc-channels'
import type { PetPackMeta } from '@shared/types'
import PetCropDialog from './PetCropDialog'
import './PetAppearance.css'

interface ElectronAPI {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
}
const api = (window as unknown as { electronAPI: ElectronAPI }).electronAPI

// 风格关键词预设
const STYLE_PRESETS = [
  '卡通像素风',
  '赛博朋克',
  '水墨国风',
  'Q 版可爱',
  '复古像素',
  '现代扁平',
  '手绘漫画',
]

interface PickedFile {
  filePath: string
  width: number
  height: number
  sizeBytes: number
  dataUrl: string
}

type PickResult =
  | { ok: true; filePath: string; width: number; height: number; sizeBytes: number; dataUrl: string }
  | { ok: false; reason: string }

type InstallResult = { ok: true; id: string } | { ok: false; reason: string }

export default function PetAppearance() {
  const [packs, setPacks] = useState<PetPackMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [feedback, setFeedback] = useState<string | null>(null)

  // sprite 裁切弹窗：picked 非空时显示 PetCropDialog
  const [picked, setPicked] = useState<PickedFile | null>(null)

  // AI 提示词
  const [style, setStyle] = useState<string>(STYLE_PRESETS[0])

  // ── 加载列表 ──────────────────────────────
  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const list = (await api.invoke(IPC.PETS_LIST)) as PetPackMeta[]
      setPacks(list)
      console.log('[PetAppearance] 已加载', list.length, '个桌宠包')
    } catch (e) {
      console.error('[PetAppearance] 加载桌宠包列表失败:', e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const showMsg = useCallback((msg: string, durationMs = 2500) => {
    setFeedback(msg)
    setTimeout(() => setFeedback(null), durationMs)
  }, [])

  // ── 切换激活 ──────────────────────────────
  const activate = useCallback(async (id: string) => {
    const r = (await api.invoke(IPC.PETS_ACTIVATE, id)) as { ok: boolean; reason?: string }
    if (r.ok) {
      showMsg('✅ 已切换桌宠')
      refresh()
    } else {
      showMsg(`❌ 切换失败：${r.reason ?? 'unknown'}`)
    }
  }, [refresh, showMsg])

  // ── 删除用户包 ────────────────────────────
  const remove = useCallback(async (id: string) => {
    if (!confirm(`确定删除桌宠包「${id}」吗？此操作不可撤销。`)) return
    const r = (await api.invoke(IPC.PETS_REMOVE, id)) as { ok: boolean; reason?: string }
    if (r.ok) {
      showMsg('🗑 已删除')
      refresh()
    } else {
      showMsg(`❌ 删除失败：${r.reason ?? 'unknown'}`)
    }
  }, [refresh, showMsg])

  // ── 上传 sprite 主入口（picked 后由 PetCropDialog 接管裁切+安装） ──
  const pickSprite = useCallback(async () => {
    const r = (await api.invoke(IPC.PETS_PICK_FILE)) as PickResult
    if (!r.ok) {
      if (r.reason !== 'cancelled') {
        const reasonMap: Record<string, string> = {
          'too-large': '文件过大（最大 8MB）',
          'not-png': '请选择 PNG 格式',
        }
        showMsg(`❌ ${reasonMap[r.reason] ?? r.reason}`)
      }
      return
    }
    setPicked(r)
  }, [showMsg])

  // 裁切弹窗回调
  const onCropInstalled = useCallback((id: string) => {
    showMsg(`✅ 已安装并激活：${id}`)
    setPicked(null)
    refresh()
  }, [refresh, showMsg])

  const onCropError = useCallback((reason: string) => {
    showMsg(`❌ ${reason}`)
  }, [showMsg])

  // ── 高级：导入 .zip ─────────────────────
  const importZip = useCallback(async () => {
    const r = (await api.invoke(IPC.PETS_INSTALL_ZIP)) as InstallResult
    if (r.ok) {
      showMsg(`✅ 已安装：${r.id}`)
      refresh()
    } else if (r.reason !== 'cancelled') {
      const reasonMap: Record<string, string> = {
        'too-large': '文件过大（最大 50MB）',
        'no-manifest': 'zip 内未找到 manifest.json',
        'unsupported-schema': 'manifest schema 版本不支持',
        'invalid-id': 'manifest.id 不合法（仅 a-z0-9_-）',
        'missing-idle': 'manifest 缺少 idle 动画',
        'path-traversal': '检测到非法路径',
        'id-reserved': '不能覆盖内置默认包',
        'zip-mixed-roots': 'zip 内必须只有一个包',
        'parse-failed': 'zip 解析失败',
      }
      const ext = r.reason.startsWith('forbidden-ext:')
        ? `不允许的文件类型：${r.reason.slice('forbidden-ext:'.length)}`
        : (reasonMap[r.reason] ?? r.reason)
      showMsg(`❌ ${ext}`)
    }
  }, [refresh, showMsg])

  const openDir = useCallback(async () => {
    await api.invoke(IPC.PETS_OPEN_DIR)
  }, [])

  // ── AI 提示词卡片 ────────────────────────
  const prompt = useMemo(() => buildPrompt(style), [style])
  const copyPrompt = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(prompt)
      showMsg('📋 提示词已复制到剪贴板')
    } catch (e) {
      console.error('[PetAppearance] 复制失败:', e)
      showMsg('❌ 复制失败，请手动选择文本复制')
    }
  }, [prompt, showMsg])

  const active = packs.find(p => p.active)

  return (
    <section className="settings-section pet-section">
      <h2>桌宠外观</h2>

      {/* 当前激活卡片 */}
      {active && (
        <div className="pet-active-card">
          {active.thumbnailUrl
            ? <img src={active.thumbnailUrl} className="pet-thumb-large" alt={active.name} draggable={false} />
            : <div className="pet-thumb-large pet-thumb-placeholder">🐱</div>}
          <div className="pet-info">
            <div className="pet-name">{active.name}</div>
            <div className="pet-meta">
              v{active.version}
              {active.author && ` · ${active.author}`}
              {active.scope === 'builtin' && ' · 内置'}
            </div>
          </div>
        </div>
      )}

      {/* 已安装网格 */}
      <div className="pet-grid">
        {loading
          ? <div className="pet-loading">加载中...</div>
          : packs.map(p => (
            <div
              key={`${p.scope}-${p.id}`}
              className={`pet-card${p.active ? ' pet-card-active' : ''}`}
              onClick={() => !p.active && activate(p.id)}
              title={p.active ? '当前激活' : '点击切换为此桌宠'}
            >
              {p.thumbnailUrl
                ? <img src={p.thumbnailUrl} alt={p.name} draggable={false} />
                : <div className="pet-thumb-placeholder-small">🐱</div>}
              <div className="pet-card-name" title={p.name}>{p.name}</div>
              {p.scope === 'user' && (
                <button
                  className="pet-card-remove"
                  onClick={e => { e.stopPropagation(); remove(p.id) }}
                  title="删除此桌宠包"
                >×</button>
              )}
            </div>
          ))}
      </div>

      {/* 上传 sprite 主入口 */}
      <button className="pet-upload-btn" onClick={pickSprite}>
        <span className="pet-upload-icon">+</span>
        <span className="pet-upload-label">上传 sprite sheet</span>
        <span className="pet-upload-hint">选 PNG → 用框选裁掉边距 → 自动按 12 帧切片导入</span>
      </button>

      {/* 高级操作 */}
      <details className="pet-advanced">
        <summary>高级操作</summary>
        <div className="pet-advanced-row">
          <button className="btn-test" onClick={importZip}>📦 导入 .zip 桌宠包</button>
          <button className="btn-test" onClick={openDir}>📂 打开桌宠目录</button>
        </div>
        <small className="pet-advanced-hint">
          .zip 适合包含独立帧序列等高级特性的桌宠包；普通用户用上方「上传 sprite sheet」即可。
        </small>
      </details>

      {/* AI 提示词卡片 */}
      <div className="pet-ai-card">
        <h3>用 AI 生成你的桌宠</h3>
        <div className="pet-ai-row">
          <label htmlFor="pet-style-input">风格关键词</label>
          <input
            id="pet-style-input"
            type="text"
            list="pet-style-presets"
            value={style}
            onChange={e => setStyle(e.target.value)}
            placeholder="例如：卡通像素风"
          />
          <datalist id="pet-style-presets">
            {STYLE_PRESETS.map(s => <option key={s} value={s} />)}
          </datalist>
        </div>
        <pre className="pet-prompt-preview">{prompt}</pre>
        <div className="pet-ai-actions">
          <button className="btn-test" onClick={copyPrompt}>📋 复制完整提示词</button>
          <small>把生成的图保存为 PNG 后，点击上方「上传 sprite sheet」即可</small>
        </div>
      </div>

      {feedback && <div className="pet-feedback">{feedback}</div>}

      {/* 裁切并导入弹窗（picked 非空时显示） */}
      {picked && (
        <PetCropDialog
          picked={picked}
          onCancel={() => setPicked(null)}
          onInstalled={onCropInstalled}
          onError={onCropError}
        />
      )}
    </section>
  )
}

/** 拼接 AI 生图提示词模板 */
function buildPrompt(style: string): string {
  const s = (style || '卡通像素风').trim()
  return `请生成一张桌宠角色 sprite sheet，规格如下：

- PNG 格式、透明背景（alpha channel），整图宽高比建议 10 : 1（参考 1440 × 144 像素，但更大尺寸也可以）
- 横向均匀排列共 12 帧，每帧宽高比 5 : 6（参考 120 × 144 像素）
- 相邻帧紧贴、无间隔、严格对齐
- 帧序与动作要求：
  · 第 1–4 帧：【空闲循环】角色站立时的轻微呼吸或眨眼
  · 第 5–6 帧：【被点击反应】角色对用户触摸的轻量回应（眨眼/微笑）
  · 第 7–8 帧：【完成任务庆祝】一次性动作（举手/小跳/转圈）
  · 第 9–12 帧：【工作中循环】角色敲键盘/搬运物品/低头思考
- 同一角色贯穿全部 12 帧，动作连贯，姿态清晰可识别
- 角色面朝画面正前方，下方留出少量阴影或站立面
- 画风风格：${s}

注：如果 AI 出图的最终尺寸不严格符合上述比例没关系，应用会让你在导入时框选裁切。`
}
