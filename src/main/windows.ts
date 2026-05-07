/**
 * 窗口管理模块
 * 负责创建透明无边框置顶窗口，处理拖动和边缘收起逻辑
 */

import { BrowserWindow, screen, app, ipcMain } from 'electron'
import path from 'path'
import { getConfig, setConfig } from './store'

const EDGE_THRESHOLD = 20   // 距屏幕边缘多少像素触发隐藏
const CAT_W = 320           // 猫咪窗口宽度
const CAT_H = 500           // 猫咪窗口高度（含气泡展开余量）

/**
 * 小猫在窗口内的可见区域参数。
 * 必须与渲染层保持同步：
 *   - 渲染层 src/renderer/src/components/PixelCat/index.tsx 的
 *     `FRAME_W * DISPLAY_SCALE` / `FRAME_H * DISPLAY_SCALE` = 120 * 0.75 / 144 * 0.75
 *   - 渲染层 src/renderer/src/App.css 的 `.app-container` 通过
 *     flex 列布局把猫水平居中、垂直贴近窗口底部（padding-bottom: 8）
 *
 * 边缘判定使用"小猫可见区域"而非"窗口边"，否则窗口大量透明留白会
 * 导致还没拖到屏幕边就触发隐藏。
 */
const CAT_VISIBLE_W = 90              // 120 * 0.75
const CAT_VISIBLE_H = 108             // 144 * 0.75
const CAT_BOTTOM_PADDING = 8          // 与 App.css 的 padding-bottom 一致
const CAT_OFFSET_X = (CAT_W - CAT_VISIBLE_W) / 2          // 窗口左 → 猫左
const CAT_OFFSET_Y = CAT_H - CAT_BOTTOM_PADDING - CAT_VISIBLE_H  // 窗口顶 → 猫顶

let mainWindow: BrowserWindow | null = null
let settingsWindow: BrowserWindow | null = null
let logWindow: BrowserWindow | null = null
let toolWindow: BrowserWindow | null = null
let aiChatWindow: BrowserWindow | null = null

const isDev = !app.isPackaged

/**
 * 获取渲染进程 URL
 * @param hash 可选 hash 路由，如 '/settings'（不含 #）
 */
function getRendererURL(hash = ''): string {
  const hashPart = hash ? `#${hash}` : ''
  if (isDev) {
    return `http://localhost:5173/${hashPart}`
  }
  return `file://${path.join(__dirname, '../../dist/index.html')}${hashPart}`
}

// ── 主窗口（像素猫） ───────────────────────────
export function createMainWindow(): BrowserWindow {
  const config = getConfig()
  const display = screen.getPrimaryDisplay()
  const { width: sw, height: sh } = display.workAreaSize

  // 默认位置：屏幕右下角
  const defaultX = sw - CAT_W - 20
  const defaultY = sh - CAT_H - 20
  const x = config.cat_position.x >= 0 ? config.cat_position.x : defaultX
  const y = config.cat_position.y >= 0 ? config.cat_position.y : defaultY

  mainWindow = new BrowserWindow({
    width: CAT_W,
    height: CAT_H,
    x,
    y,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,          // 不在任务栏显示
    resizable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.loadURL(getRendererURL())

  // 默认透明区域穿透点击，{ forward: true } 保证 mousemove 仍然转发给渲染进程
  mainWindow.setIgnoreMouseEvents(true, { forward: true })

  // 渲染进程通过 mousemove + elementFromPoint 检测光标是否在可见元素上
  // 进入可见元素时发 false，离开时发 true
  ipcMain.on('window:set-ignore-mouse-events', (_e, ignore: boolean) => {
    mainWindow?.setIgnoreMouseEvents(ignore, { forward: true })
  })

  // 注册窗口拖动 IPC（手动实现拖动）
  ipcMain.on('window:drag-start', () => {
    // 拖动开始时确保鼠标事件不被忽略
    mainWindow?.setIgnoreMouseEvents(false)
  })

  ipcMain.on('window:drag-move', (_e, deltaX: number, deltaY: number) => {
    if (mainWindow) {
      const [wx, wy] = mainWindow.getPosition()
      mainWindow.setPosition(wx + deltaX, wy + deltaY)
    }
  })

  ipcMain.on('window:drag-end', () => {
    if (mainWindow) {
      const [wx, wy] = mainWindow.getPosition()
      setConfig({ cat_position: { x: wx, y: wy } })
      checkEdgeHide(wx, wy)
      // 拖动结束后恢复透明穿透
      mainWindow.setIgnoreMouseEvents(true, { forward: true })
    }
  })

  // 仅保存位置；不在此触发隐藏判定，避免拖动过程中（drag-move 内的
  // setPosition 也会触发 'moved'）窗口在用户还按着鼠标时突然消失。
  // 隐藏判定只在 drag-end（手松开）时进行。
  mainWindow.on('moved', () => {
    if (!mainWindow) return
    const [wx, wy] = mainWindow.getPosition()
    setConfig({ cat_position: { x: wx, y: wy } })
  })

  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  }

  return mainWindow
}

/**
 * 检查是否拖到屏幕边缘。若是 → "最小化式"隐藏整个窗口（含气泡）。
 *
 * 注意：直接 mainWindow.hide() 而不是把窗口推出屏幕外，是因为：
 *   - 推出屏幕只能藏住小猫本体，气泡（bubble-layer）位于小猫上方，气泡冒出
 *     时其内容仍会出现在屏幕里（半截浮在屏幕底/顶）。
 *   - hide() 把整个窗口隐藏，气泡也不会再泄露。
 *
 * 恢复入口：托盘左键点击 / 托盘菜单"🐱 显示小猫"
 *   → showMainWindow() 会在 cat_hidden=true 时复位到屏幕右下角并 show()。
 */
function checkEdgeHide(wx: number, wy: number): void {
  if (!mainWindow) return
  const display = screen.getDisplayNearestPoint({ x: wx, y: wy })
  // 使用 bounds（物理屏幕边界）而不是 workArea：
  // macOS 上 alwaysOnTop 窗口会覆盖 dock，若用 workArea 会把 dock 上方误判为
  // "屏幕底"，用户感觉还没拖到底就触发隐藏。
  const { x: dx, y: dy, width: dw, height: dh } = display.bounds

  // 小猫可见区域在屏幕上的坐标（窗口大量透明，必须用猫的边而非窗口边判定）
  const catLeft   = wx + CAT_OFFSET_X
  const catRight  = catLeft + CAT_VISIBLE_W
  const catTop    = wy + CAT_OFFSET_Y
  const catBottom = catTop + CAT_VISIBLE_H

  const nearLeft   = catLeft - dx < EDGE_THRESHOLD
  const nearRight  = (dx + dw) - catRight < EDGE_THRESHOLD
  const nearTop    = catTop - dy < EDGE_THRESHOLD
  const nearBottom = (dy + dh) - catBottom < EDGE_THRESHOLD

  if (nearLeft || nearRight || nearTop || nearBottom) {
    console.log('[Window] 拖到屏幕边缘，最小化式隐藏小猫；从托盘恢复')
    mainWindow.hide()
    setConfig({ cat_hidden: true })
  } else {
    setConfig({ cat_hidden: false })
  }
}

/** 从托盘点击时显示猫咪，只在猫被收起到边缘时才复位到右下角 */
export function showMainWindow(): void {
  if (!mainWindow) return
  const config = getConfig()

  if (config.cat_hidden) {
    // 收起状态，恢复到屏幕右下角
    const display = screen.getPrimaryDisplay()
    const { width: sw, height: sh } = display.workAreaSize
    const x = sw - CAT_W - 20
    const y = sh - CAT_H - 20
    mainWindow.setPosition(x, y)
    setConfig({ cat_hidden: false, cat_position: { x, y } })
  }

  // 无论如何确保窗口可见并获得焦点
  mainWindow.show()
  mainWindow.focus()
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

// ── 设置窗口 ───────────────────────────────────
export function openSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus()
    return
  }

  settingsWindow = new BrowserWindow({
    width: 520,
    height: 720,
    title: '小小牛马 - 设置',
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  settingsWindow.loadURL(getRendererURL('/settings'))

  settingsWindow.on('closed', () => {
    settingsWindow = null
  })
}

// ── 日志查看窗口 ──────────────────────────────────
export function openLogWindow(): void {
  if (logWindow && !logWindow.isDestroyed()) {
    logWindow.focus()
    return
  }

  logWindow = new BrowserWindow({
    width: 560,
    height: 680,
    title: '小小牛马 - 工作日志',
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  logWindow.loadURL(getRendererURL('/logs'))

  logWindow.on('closed', () => {
    logWindow = null
  })
}

// ── 小工具窗口 ──────────────────────────────────
export function openToolWindow(): void {
  if (toolWindow && !toolWindow.isDestroyed()) {
    toolWindow.focus()
    return
  }

  toolWindow = new BrowserWindow({
    width: 520,
    height: 740,
    title: '小小牛马 - 小工具',
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  toolWindow.loadURL(getRendererURL('/tools'))

  toolWindow.on('closed', () => {
    toolWindow = null
  })
}

// ── AI 快速对话窗口 ────────────────────────────
/**
 * 打开（或复用）AI 对话窗口。
 * 若窗口已存在则聚焦并通知其聚焦输入框。
 * 尺寸与位置会记忆到 config.ai_chat_window_bounds。
 */
export function openAIChatWindow(): void {
  if (aiChatWindow && !aiChatWindow.isDestroyed()) {
    if (aiChatWindow.isMinimized()) aiChatWindow.restore()
    aiChatWindow.show()
    aiChatWindow.focus()
    aiChatWindow.webContents.send('main:ai-chat-focus-input')
    return
  }

  // 读取上次记忆的 bounds（尺寸 + 位置），无记录则用默认值
  const saved = getConfig().ai_chat_window_bounds
  const winOpts: Electron.BrowserWindowConstructorOptions = {
    width: saved?.width ?? 760,
    height: saved?.height ?? 680,
    minWidth: 520,
    minHeight: 480,
    title: '小小牛马 · AI 对话',
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  }
  if (saved && typeof saved.x === 'number' && typeof saved.y === 'number') {
    winOpts.x = saved.x
    winOpts.y = saved.y
  }
  aiChatWindow = new BrowserWindow(winOpts)

  aiChatWindow.loadURL(getRendererURL('/ai-chat'))

  // 保存尺寸/位置：debounce 处理，避免拖动过程频繁写盘
  let saveTimer: NodeJS.Timeout | null = null
  const saveBounds = () => {
    if (!aiChatWindow || aiChatWindow.isDestroyed()) return
    const b = aiChatWindow.getBounds()
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      setConfig({ ai_chat_window_bounds: b })
    }, 300)
  }
  aiChatWindow.on('resize', saveBounds)
  aiChatWindow.on('move', saveBounds)

  aiChatWindow.on('closed', () => {
    aiChatWindow = null
    if (saveTimer) clearTimeout(saveTimer)
  })

  if (isDev) {
    // 开发期自动打开 devtools 便于调试流式输出
    // aiChatWindow.webContents.openDevTools({ mode: 'detach' })
  }
}

export function getAIChatWindow(): BrowserWindow | null {
  return aiChatWindow
}
