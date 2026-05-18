/**
 * 桌宠包（Pet Pack）仓库
 *
 * 负责：
 *  1. 注册 `pet://` 自定义协议，把 pet://<scope>/<id>/<rel> 解析到物理路径；
 *  2. 扫描内置（assets/pets）+ 用户（{userData}/pets）目录，列出所有合法包；
 *  3. 从 sprite PNG 单张上传 → 自动生成 manifest，安装为新包；
 *  4. 从 .zip 文件导入用户包；
 *  5. 删除用户包；
 *  6. 当激活包变更时广播 PETS_CHANGED 给所有渲染窗口。
 *
 * pet:// URL 设计：
 *   - pet://builtin/<id>/<rel> 指向内置包
 *   - pet://user/<id>/<rel>    指向用户包
 *   两者解析后再做路径穿越防护（rel 不允许 ..）
 */

import { app, BrowserWindow, dialog, ipcMain, protocol, shell } from 'electron'
import fs from 'fs'
import path from 'path'
import JSZip from 'jszip'
import log from 'electron-log/main'
import { IPC } from '@shared/ipc-channels'
import type {
  ActivePetPack,
  CatState,
  PetAnimationSpec,
  PetManifest,
  PetPackMeta,
  PetPackScope,
} from '@shared/types'
import { getConfig, setConfig } from './store'

// ── 路径常量 ──────────────────────────────────
const DEFAULT_PACK_ID = 'default-cat'
const PET_SCHEME = 'pet'
const MAX_USER_PACK_BYTES = 50 * 1024 * 1024 // 50MB
const MAX_SPRITE_BYTES = 8 * 1024 * 1024     // 8MB

const isDev = !app.isPackaged

/** 内置包根目录 */
function builtinRoot(): string {
  return isDev
    ? path.join(__dirname, '../../assets/pets')
    : path.join(process.resourcesPath, 'pets')
}

/** 用户包根目录 */
function userRoot(): string {
  return path.join(app.getPath('userData'), 'pets')
}

function ensureUserRoot(): void {
  const dir = userRoot()
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

/** 简易 mime 推断：仅覆盖桌宠包内允许的资源类型 */
function mimeFromExt(ext: string): string {
  const e = ext.toLowerCase().replace(/^\./, '')
  switch (e) {
    case 'png':  return 'image/png'
    case 'jpg':
    case 'jpeg': return 'image/jpeg'
    case 'webp': return 'image/webp'
    case 'gif':  return 'image/gif'
    case 'json': return 'application/json'
    default:     return 'application/octet-stream'
  }
}

// ── 必须在 app.ready 之前调用：注册 scheme 特权 ──
/** 在主进程模块解析期调用一次：声明 pet:// 是 standard + secure，img/fetch 等能正常加载 */
export function registerPetSchemePrivileged(): void {
  try {
    protocol.registerSchemesAsPrivileged([
      {
        scheme: PET_SCHEME,
        privileges: {
          standard: true,
          secure: true,
          supportFetchAPI: true,
          stream: true,
          bypassCSP: true,
        },
      },
    ])
    console.log('[PetPack] pet:// scheme 已声明为特权 scheme')
  } catch (e) {
    log.warn('[PetPack] registerSchemesAsPrivileged 失败:', e)
  }
}

/**
 * 把 pet:// URL 解析为物理文件绝对路径；非法/越界 URL 返回 null
 */
function resolvePetUrl(urlStr: string): string | null {
  try {
    const url = new URL(urlStr)
    if (url.protocol !== `${PET_SCHEME}:`) return null
    const scope = url.host as PetPackScope
    if (scope !== 'builtin' && scope !== 'user') return null
    // pathname 形如 /<id>/<rel...>; 去除前导 /
    const parts = url.pathname.replace(/^\/+/, '').split('/').filter(Boolean)
    if (parts.length < 2) return null
    const [packId, ...rest] = parts
    if (!isValidPackId(packId)) return null
    // 拒绝任何 `..` 段
    if (rest.some(seg => seg === '..' || seg === '.' || seg.includes('\0'))) return null
    const rootDir = scope === 'builtin' ? builtinRoot() : userRoot()
    const packDir = path.join(rootDir, packId)
    const target = path.join(packDir, ...rest)
    // 二次防护：解析后必须仍在包目录内
    const rel = path.relative(packDir, target)
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null
    return target
  } catch (e) {
    log.warn('[PetPack] resolvePetUrl 解析失败:', urlStr, e)
    return null
  }
}

/** 在 app.whenReady() 之后调用：绑定 protocol handler，建好用户目录 */
export function initPetPackStore(): void {
  ensureUserRoot()

  // Electron 25+ 的新 API：protocol.handle（推荐用法）
  protocol.handle(PET_SCHEME, async request => {
    const filePath = resolvePetUrl(request.url)
    if (!filePath) {
      log.warn('[PetPack] pet:// 解析失败或越界:', request.url)
      return new Response('Not Found', { status: 404 })
    }
    if (!fs.existsSync(filePath)) {
      log.warn('[PetPack] pet:// 文件不存在:', filePath)
      return new Response('Not Found', { status: 404 })
    }
    try {
      // 直接 fs 读取后构造 Response：避免 net.fetch 对 file:// 的支持差异
      const buf = fs.readFileSync(filePath)
      const ct = mimeFromExt(path.extname(filePath))
      return new Response(buf, {
        status: 200,
        headers: {
          'Content-Type': ct,
          // sprite/帧资源在 dev 时会频繁切换；仅做内存级缓存即可
          'Cache-Control': 'no-cache',
        },
      })
    } catch (e) {
      log.error('[PetPack] pet:// 读文件失败:', filePath, e)
      return new Response('Internal Error', { status: 500 })
    }
  })
  console.log('[PetPack] pet:// protocol handler 已注册')

  // 启动时也确保默认包 id 存在，否则回退
  const cfg = getConfig()
  const meta = listPacksInternal()
  if (!meta.some(m => m.id === cfg.active_pet_pack)) {
    console.log('[PetPack] 当前 active_pet_pack 不存在，回退到', DEFAULT_PACK_ID)
    setConfig({ active_pet_pack: DEFAULT_PACK_ID })
  }
}

// ── 校验 ──────────────────────────────────────
const PACK_ID_PATTERN = /^[a-z0-9_-]{1,64}$/
function isValidPackId(id: unknown): id is string {
  return typeof id === 'string' && PACK_ID_PATTERN.test(id)
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-_\s]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  const trimmed = base.slice(0, 48) || 'pet'
  return trimmed
}

/** 读取并初步校验某目录下的 manifest.json；非法时返回 null */
function readManifest(packDir: string): PetManifest | null {
  const file = path.join(packDir, 'manifest.json')
  if (!fs.existsSync(file)) return null
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf-8')) as PetManifest
    if (json.schema !== 'xiaoniu-pet/v1') return null
    if (!isValidPackId(json.id)) return null
    if (!json.frame || typeof json.frame.width !== 'number' || typeof json.frame.height !== 'number') return null
    if (!json.animations || !json.animations.idle) return null
    return json
  } catch (e) {
    log.warn('[PetPack] manifest 解析失败:', file, e)
    return null
  }
}

function manifestToMeta(manifest: PetManifest, scope: PetPackScope, active: boolean): PetPackMeta {
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    author: manifest.author,
    description: manifest.description,
    scope,
    thumbnailUrl: manifest.thumbnail ? `pet://${scope}/${manifest.id}/${manifest.thumbnail}` : null,
    active,
  }
}

// ── 列出已安装包 ──────────────────────────────
function listPacksInternal(): PetPackMeta[] {
  const cfg = getConfig()
  const activeId = cfg.active_pet_pack
  const result: PetPackMeta[] = []

  const scan = (root: string, scope: PetPackScope) => {
    if (!fs.existsSync(root)) return
    for (const name of fs.readdirSync(root)) {
      const dir = path.join(root, name)
      try {
        if (!fs.statSync(dir).isDirectory()) continue
      } catch { continue }
      const manifest = readManifest(dir)
      if (!manifest) continue
      // 目录名必须与 manifest.id 一致，否则忽略（防止 id 冲突）
      if (manifest.id !== name) {
        log.warn('[PetPack] 目录名与 manifest.id 不一致，忽略:', dir, manifest.id)
        continue
      }
      result.push(manifestToMeta(manifest, scope, manifest.id === activeId))
    }
  }
  scan(builtinRoot(), 'builtin')
  scan(userRoot(), 'user')
  return result
}

export function listPacks(): PetPackMeta[] {
  return listPacksInternal()
}

// ── 获取激活包 ────────────────────────────────
function findPack(id: string): { manifest: PetManifest; dir: string; scope: PetPackScope } | null {
  const candidates: Array<{ root: string; scope: PetPackScope }> = [
    { root: userRoot(),    scope: 'user' },     // 用户包优先（允许覆盖同 id 内置包）
    { root: builtinRoot(), scope: 'builtin' },
  ]
  for (const { root, scope } of candidates) {
    const dir = path.join(root, id)
    if (!fs.existsSync(dir)) continue
    const manifest = readManifest(dir)
    if (!manifest || manifest.id !== id) continue
    return { manifest, dir, scope }
  }
  return null
}

/**
 * 把 manifest 中的相对路径替换为 pet:// URL
 * （source / frames[] / thumbnail）
 */
function normalizeManifest(manifest: PetManifest, scope: PetPackScope): PetManifest {
  const base = `pet://${scope}/${manifest.id}/`
  const resolve = (p: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(p) ? p : base + p.replace(/^\/+/, '')
  const animations = { ...manifest.animations } as Record<CatState, PetAnimationSpec>
  for (const k of Object.keys(animations) as CatState[]) {
    const anim = animations[k]
    if (!anim) continue
    if (anim.type === 'sprite') {
      animations[k] = { ...anim, source: resolve(anim.source) }
    } else {
      animations[k] = { ...anim, frames: anim.frames.map(resolve) }
    }
  }
  return {
    ...manifest,
    thumbnail: manifest.thumbnail ? resolve(manifest.thumbnail) : manifest.thumbnail,
    animations,
  }
}

export function getActivePack(): ActivePetPack | null {
  const cfg = getConfig()
  const wanted = cfg.active_pet_pack || DEFAULT_PACK_ID
  let found = findPack(wanted)
  if (!found && wanted !== DEFAULT_PACK_ID) {
    log.warn('[PetPack] 激活包未找到，回退默认:', wanted)
    found = findPack(DEFAULT_PACK_ID)
  }
  if (!found) {
    log.error('[PetPack] 默认包也找不到，请检查安装')
    return null
  }
  const meta = manifestToMeta(found.manifest, found.scope, true)
  const normalized = normalizeManifest(found.manifest, found.scope)
  return {
    meta,
    manifest: normalized,
    baseUrl: `pet://${found.scope}/${found.manifest.id}/`,
  }
}

// ── 激活某包 ──────────────────────────────────
function broadcastChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.webContents.send(IPC.PETS_CHANGED)
    } catch {
      /* ignore */
    }
  }
}

export function setActivePack(id: string): { ok: boolean; reason?: string } {
  if (!isValidPackId(id)) return { ok: false, reason: 'invalid-id' }
  const found = findPack(id)
  if (!found) return { ok: false, reason: 'not-found' }
  setConfig({ active_pet_pack: id })
  console.log('[PetPack] 已激活桌宠包:', id, found.scope)
  broadcastChanged()
  return { ok: true }
}

// ── 删除用户包 ────────────────────────────────
export function removePack(id: string): { ok: boolean; reason?: string } {
  if (!isValidPackId(id)) return { ok: false, reason: 'invalid-id' }
  if (id === DEFAULT_PACK_ID) return { ok: false, reason: 'cannot-remove-builtin' }
  const dir = path.join(userRoot(), id)
  if (!fs.existsSync(dir)) return { ok: false, reason: 'not-found' }
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch (e) {
    log.error('[PetPack] 删除包失败:', dir, e)
    return { ok: false, reason: 'delete-failed' }
  }
  // 删除的恰好是激活包 → 回退到默认
  const cfg = getConfig()
  if (cfg.active_pet_pack === id) {
    setConfig({ active_pet_pack: DEFAULT_PACK_ID })
    console.log('[PetPack] 删除的是激活包，已回退到', DEFAULT_PACK_ID)
  }
  broadcastChanged()
  return { ok: true }
}

// ── 打开用户包目录 ────────────────────────────
export async function openPacksDir(): Promise<{ ok: boolean; path?: string; error?: string }> {
  ensureUserRoot()
  const dir = userRoot()
  const err = await shell.openPath(dir)
  if (err) return { ok: false, error: err }
  return { ok: true, path: dir }
}

// ── 文件对话框：选择 PNG ──────────────────────
/**
 * 弹出文件对话框，让用户选一张 sprite sheet PNG。
 * 返回路径 + 解析出的尺寸（PNG 头部读取），让渲染端做预览/校验。
 */
export async function pickSpriteFile(): Promise<
  { ok: true; filePath: string; width: number; height: number; sizeBytes: number; dataUrl: string }
  | { ok: false; reason: string }
> {
  const result = await dialog.showOpenDialog({
    title: '选择桌宠 sprite sheet（PNG）',
    properties: ['openFile'],
    filters: [{ name: 'PNG 图片', extensions: ['png'] }],
  })
  if (result.canceled || result.filePaths.length === 0) {
    return { ok: false, reason: 'cancelled' }
  }
  const filePath = result.filePaths[0]
  const stat = fs.statSync(filePath)
  if (stat.size > MAX_SPRITE_BYTES) {
    return { ok: false, reason: 'too-large' }
  }
  const size = readPngSize(filePath)
  if (!size) return { ok: false, reason: 'not-png' }
  // 同时返回 base64 dataURL 供渲染端预览（webSecurity: true 时无法直接加载 file://）
  let dataUrl = ''
  try {
    const buf = fs.readFileSync(filePath)
    dataUrl = `data:image/png;base64,${buf.toString('base64')}`
  } catch (e) {
    log.warn('[PetPack] 读取 PNG 生成 dataUrl 失败:', e)
  }
  return {
    ok: true,
    filePath,
    width: size.width,
    height: size.height,
    sizeBytes: stat.size,
    dataUrl,
  }
}

/** 解析 PNG 文件的宽高（不需要额外依赖） */
function readPngSize(filePath: string): { width: number; height: number } | null {
  try {
    const fd = fs.openSync(filePath, 'r')
    const buf = Buffer.alloc(24)
    fs.readSync(fd, buf, 0, 24, 0)
    fs.closeSync(fd)
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    if (
      buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47 ||
      buf[4] !== 0x0d || buf[5] !== 0x0a || buf[6] !== 0x1a || buf[7] !== 0x0a
    ) {
      return null
    }
    // IHDR chunk: bytes 8..16 是 length(4) + 'IHDR'(4)，width/height 在 16/20
    const width = buf.readUInt32BE(16)
    const height = buf.readUInt32BE(20)
    if (width <= 0 || height <= 0) return null
    return { width, height }
  } catch {
    return null
  }
}

// ── 安装：从单张 sprite sheet 自动生成标准包 ──
const SPRITE_FRAME_W = 120
const SPRITE_FRAME_H = 144
const SPRITE_TOTAL_FRAMES = 12
const SPRITE_TOTAL_W = SPRITE_FRAME_W * SPRITE_TOTAL_FRAMES // 1440
const SIZE_TOLERANCE = 2 // 像素容差

/** 生成不冲突的 pack id（在用户目录里） */
function uniqueUserPackId(baseSlug: string): string {
  let id = baseSlug
  let n = 1
  while (fs.existsSync(path.join(userRoot(), id))) {
    n += 1
    id = `${baseSlug}-${n}`
    if (n > 999) throw new Error('id-collision-exhausted')
  }
  return id
}

interface InstallSpriteInput {
  /** 主进程预先解析过的 PNG 路径（由 pickSpriteFile 提供） */
  filePath: string
  /** 用户填的展示名 */
  name: string
  /** 可选作者 */
  author?: string
}

export function installPackFromSprite(input: InstallSpriteInput): { ok: true; id: string }
  | { ok: false; reason: string } {
  ensureUserRoot()
  if (!input.filePath || !fs.existsSync(input.filePath)) {
    return { ok: false, reason: 'file-missing' }
  }
  const name = (input.name || '').trim()
  if (!name) return { ok: false, reason: 'name-required' }
  // 尺寸校验
  const size = readPngSize(input.filePath)
  if (!size) return { ok: false, reason: 'not-png' }
  if (Math.abs(size.width - SPRITE_TOTAL_W) > SIZE_TOLERANCE ||
      Math.abs(size.height - SPRITE_FRAME_H) > SIZE_TOLERANCE) {
    return { ok: false, reason: 'size-mismatch' }
  }

  let id: string
  try {
    id = uniqueUserPackId(slugify(name))
  } catch {
    return { ok: false, reason: 'id-collision' }
  }

  const dir = path.join(userRoot(), id)
  try {
    fs.mkdirSync(dir, { recursive: true })
    // 1. 复制 sprite
    fs.copyFileSync(input.filePath, path.join(dir, 'sprite_all.png'))
    // 2. 生成 thumbnail（直接复用 sprite，渲染端 background-position 截取第 0 帧；
    //    缩略图就用整张 sprite_all 作为兜底，UI 自行裁剪显示）
    //    更专业的做法是单独切第 0 帧，但为减依赖此处不做（如需可后续加 sharp/canvas）
    fs.copyFileSync(input.filePath, path.join(dir, 'thumbnail.png'))
    // 3. 写 manifest
    const manifest = buildStandardManifest(id, name, input.author)
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8')
    console.log('[PetPack] 已从 sprite 安装新包:', id, '(', dir, ')')
    return { ok: true, id }
  } catch (e) {
    log.error('[PetPack] installPackFromSprite 失败:', e)
    // 清理失败目录
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
    return { ok: false, reason: 'write-failed' }
  }
}

// ── 安装：从渲染端裁切后的 PNG 字节导入 ────────
interface InstallBytesInput {
  /** 用户填的展示名 */
  name: string
  /** 可选作者 */
  author?: string
  /** 裁切后的 PNG 字节（base64 或 Uint8Array 经 IPC 结构化克隆后会到达） */
  bytes: ArrayBuffer | Uint8Array
  /** 单帧实际像素宽（= 裁切后整图宽度 / 12） */
  frameWidth: number
  /** 单帧实际像素高（= 裁切后整图高度） */
  frameHeight: number
}

/**
 * 渲染端裁切后调用。不做尺寸严格匹配（W = frameWidth*12、H = frameHeight 由前端保证），
 * 仅做：PNG 头校验、字节上限、合理帧尺寸（避免 0/极小/极大）。
 */
export function installPackFromBytes(input: InstallBytesInput): { ok: true; id: string }
  | { ok: false; reason: string } {
  ensureUserRoot()
  const name = (input.name || '').trim()
  if (!name) return { ok: false, reason: 'name-required' }

  // 入参 → Buffer（兼容 ArrayBuffer / Uint8Array / 主进程接到 IPC 时的 Buffer-like 对象）
  let buf: Buffer
  try {
    if (input.bytes instanceof ArrayBuffer) {
      buf = Buffer.from(input.bytes)
    } else if (input.bytes && typeof (input.bytes as Uint8Array).byteLength === 'number') {
      const u = input.bytes as Uint8Array
      buf = Buffer.from(u.buffer, u.byteOffset, u.byteLength)
    } else {
      return { ok: false, reason: 'invalid-bytes' }
    }
  } catch (e) {
    log.error('[PetPack] installPackFromBytes 解析字节失败:', e)
    return { ok: false, reason: 'invalid-bytes' }
  }

  if (buf.length === 0) return { ok: false, reason: 'invalid-bytes' }
  if (buf.length > MAX_SPRITE_BYTES) return { ok: false, reason: 'too-large' }

  // PNG 签名：89 50 4E 47 0D 0A 1A 0A
  if (buf.length < 8 ||
      buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47 ||
      buf[4] !== 0x0d || buf[5] !== 0x0a || buf[6] !== 0x1a || buf[7] !== 0x0a) {
    return { ok: false, reason: 'not-png' }
  }

  // 帧尺寸合理性
  const fw = Math.floor(input.frameWidth)
  const fh = Math.floor(input.frameHeight)
  if (!Number.isFinite(fw) || !Number.isFinite(fh)) return { ok: false, reason: 'frame-size-invalid' }
  if (fw < 16 || fh < 16) return { ok: false, reason: 'frame-too-small' }
  if (fw > 1024 || fh > 1024) return { ok: false, reason: 'frame-too-large' }

  let id: string
  try {
    id = uniqueUserPackId(slugify(name))
  } catch {
    return { ok: false, reason: 'id-collision' }
  }

  const dir = path.join(userRoot(), id)
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'sprite_all.png'), buf)
    // 缩略图复用整张 sprite（UI 用 object-fit:cover + position 0 0 自动展示第 0 帧）
    fs.writeFileSync(path.join(dir, 'thumbnail.png'), buf)
    const manifest = buildStandardManifest(id, name, input.author, {
      frameWidth: fw,
      frameHeight: fh,
    })
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8')
    console.log('[PetPack] 已从字节流安装新包:', id, `(${fw}×${fh}×12, ${buf.length}B)`)
    return { ok: true, id }
  } catch (e) {
    log.error('[PetPack] installPackFromBytes 失败:', e)
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
    return { ok: false, reason: 'write-failed' }
  }
}

interface StandardManifestOptions {
  /** 单帧实际像素宽（裁切后宽度 / 12） */
  frameWidth?: number
  /** 单帧实际像素高（=裁切后高度） */
  frameHeight?: number
  /** 显示缩放；缺省时按 frameWidth 自动估算（让显示宽接近 90px） */
  displayScale?: number
}

/**
 * 构造 12 帧布局的标准 manifest（idle/petting/celebrate/busy）。
 * frameWidth/Height 缺省时回退到 120×144 标准尺寸；displayScale 缺省时按帧宽自适应。
 */
function buildStandardManifest(
  id: string,
  name: string,
  author?: string,
  opts: StandardManifestOptions = {}
): PetManifest {
  const frameWidth = Math.max(8, Math.floor(opts.frameWidth ?? SPRITE_FRAME_W))
  const frameHeight = Math.max(8, Math.floor(opts.frameHeight ?? SPRITE_FRAME_H))
  // 自适应缩放：让桌宠在屏幕上的显示宽度 ≈ 90px（与原 120×0.75=90 视觉等价）；
  // 限制在 [0.25, 2.0] 内，避免极端比例下的灾难性大小
  const autoScale = clampScale(90 / frameWidth)
  const displayScale = opts.displayScale ?? autoScale
  return {
    schema: 'xiaoniu-pet/v1',
    id,
    name,
    version: '1.0.0',
    author: author?.trim() || undefined,
    thumbnail: 'thumbnail.png',
    frame: { width: frameWidth, height: frameHeight, displayScale },
    fallback: 'idle',
    animations: {
      idle: {
        type: 'sprite', source: 'sprite_all.png',
        startFrame: 0, frameCount: 4, fps: 2, loop: true, layout: 'horizontal',
      },
      petting: {
        type: 'sprite', source: 'sprite_all.png',
        startFrame: 4, frameCount: 2, fps: 5, loop: true, layout: 'horizontal',
      },
      celebrate: {
        type: 'sprite', source: 'sprite_all.png',
        startFrame: 6, frameCount: 2, fps: 5, loop: false, layout: 'horizontal',
      },
      busy: {
        type: 'sprite', source: 'sprite_all.png',
        startFrame: 8, frameCount: 4, fps: 6, loop: true, layout: 'horizontal',
      },
    },
  }
}

function clampScale(v: number): number {
  if (!Number.isFinite(v)) return 0.75
  return Math.max(0.25, Math.min(2.0, Math.round(v * 100) / 100))
}

// ── 安装：从 .zip 导入（高级路径） ────────────
const ZIP_FILE_EXT_WHITELIST = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.json'])

/** 弹文件对话框 → 解压 zip → 校验 manifest → 写入 userData/pets/<id> */
export async function installPackFromZip(): Promise<{ ok: true; id: string }
  | { ok: false; reason: string }> {
  ensureUserRoot()
  const picked = await dialog.showOpenDialog({
    title: '导入桌宠包（.zip）',
    properties: ['openFile'],
    filters: [{ name: '桌宠包', extensions: ['zip'] }],
  })
  if (picked.canceled || picked.filePaths.length === 0) {
    return { ok: false, reason: 'cancelled' }
  }
  const zipPath = picked.filePaths[0]
  const stat = fs.statSync(zipPath)
  if (stat.size > MAX_USER_PACK_BYTES) {
    return { ok: false, reason: 'too-large' }
  }
  try {
    const buf = fs.readFileSync(zipPath)
    const zip = await JSZip.loadAsync(buf)
    // 找 manifest.json（可能在根，也可能在某个子目录里）
    const entries = Object.values(zip.files).filter(f => !f.dir)
    const manifestEntry = entries.find(e => e.name.endsWith('manifest.json'))
    if (!manifestEntry) return { ok: false, reason: 'no-manifest' }
    const manifestText = await manifestEntry.async('text')
    const manifest = JSON.parse(manifestText) as PetManifest
    if (manifest.schema !== 'xiaoniu-pet/v1') return { ok: false, reason: 'unsupported-schema' }
    if (!isValidPackId(manifest.id)) return { ok: false, reason: 'invalid-id' }
    if (!manifest.animations?.idle) return { ok: false, reason: 'missing-idle' }

    const rootPrefix = manifestEntry.name.replace(/manifest\.json$/, '')
    // 校验白名单：所有文件必须在 rootPrefix 下且扩展名合法、文件名无 ..
    for (const e of entries) {
      if (!e.name.startsWith(rootPrefix)) {
        return { ok: false, reason: 'zip-mixed-roots' }
      }
      if (e.name.includes('..')) return { ok: false, reason: 'path-traversal' }
      const ext = path.extname(e.name).toLowerCase()
      if (ext && !ZIP_FILE_EXT_WHITELIST.has(ext)) {
        return { ok: false, reason: `forbidden-ext:${ext}` }
      }
    }

    // 不允许覆盖默认包；同 id 冲突则递增
    let targetId = manifest.id
    if (targetId === DEFAULT_PACK_ID) {
      return { ok: false, reason: 'id-reserved' }
    }
    if (fs.existsSync(path.join(userRoot(), targetId))) {
      targetId = uniqueUserPackId(targetId)
    }
    const targetDir = path.join(userRoot(), targetId)
    fs.mkdirSync(targetDir, { recursive: true })

    for (const e of entries) {
      const rel = e.name.slice(rootPrefix.length)
      if (!rel) continue
      const dest = path.join(targetDir, rel)
      // 二次防护：解析后必须仍在 targetDir 下
      const relCheck = path.relative(targetDir, dest)
      if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
        fs.rmSync(targetDir, { recursive: true, force: true })
        return { ok: false, reason: 'path-traversal' }
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      const content = await e.async('nodebuffer')
      fs.writeFileSync(dest, content)
    }

    // 若 manifest.id 改了（冲突重命名），更新写入的 manifest
    if (targetId !== manifest.id) {
      manifest.id = targetId
      fs.writeFileSync(path.join(targetDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8')
    }
    console.log('[PetPack] 已从 zip 安装包:', targetId)
    return { ok: true, id: targetId }
  } catch (e) {
    log.error('[PetPack] installPackFromZip 失败:', e)
    return { ok: false, reason: 'parse-failed' }
  }
}

// ── IPC 注册入口 ─────────────────────────────
export function registerPetPackIPC(): void {
  ipcMain.handle(IPC.PETS_LIST, () => listPacks())
  ipcMain.handle(IPC.PETS_GET_ACTIVE, () => getActivePack())
  ipcMain.handle(IPC.PETS_ACTIVATE, (_e, id: string) => setActivePack(id))
  ipcMain.handle(IPC.PETS_REMOVE, (_e, id: string) => removePack(id))
  ipcMain.handle(IPC.PETS_OPEN_DIR, () => openPacksDir())
  ipcMain.handle(IPC.PETS_PICK_FILE, () => pickSpriteFile())
  ipcMain.handle(IPC.PETS_INSTALL_SPRITE, (_e, input: InstallSpriteInput) => {
    const r = installPackFromSprite(input)
    if (r.ok) {
      setActivePack(r.id) // 安装即激活
    }
    return r
  })
  ipcMain.handle(IPC.PETS_INSTALL_SPRITE_BYTES, (_e, input: InstallBytesInput) => {
    const r = installPackFromBytes(input)
    if (r.ok) {
      setActivePack(r.id) // 安装即激活
    }
    return r
  })
  ipcMain.handle(IPC.PETS_INSTALL_ZIP, async () => {
    const r = await installPackFromZip()
    if (r.ok) {
      setActivePack(r.id)
    }
    return r
  })
  console.log('[PetPack] IPC handlers 已注册')
}
