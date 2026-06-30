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
let chatWindow: BrowserWindow | null = null
let skillsWindow: BrowserWindow | null = null
let agentCronWindow: BrowserWindow | null = null

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

interface SubWindowOptions {
  hash: string
  title: string
  width: number
  height: number
  minWidth?: number
  minHeight?: number
  resizable?: boolean
}

/**
 * 创建或激活子窗口通用工厂函数
 */
function createOrFocusSubWindow(
  options: SubWindowOptions,
  getWin: () => BrowserWindow | null,
  setWin: (win: BrowserWindow | null) => void
): BrowserWindow {
  let win = getWin()

  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    return win
  }

  win = new BrowserWindow({
    width: options.width,
    height: options.height,
    minWidth: options.minWidth,
    minHeight: options.minHeight,
    title: options.title,
    resizable: options.resizable ?? true,
    backgroundColor: '#f7f5ef',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  win.loadURL(getRendererURL(options.hash))

  win.on('closed', () => {
    setWin(null)
  })

  setWin(win)
  return win
}

// ── 设置窗口（已弃用独立窗口，重定向到主聊天窗口内部路由） ──
export function openSettingsWindow(): void {
  openChatWindow()
  if (chatWindow && !chatWindow.isDestroyed()) {
    chatWindow.webContents.send('main:open-settings-view')
  }
}

// ── 日志查看窗口 ──────────────────────────────────
export function openLogWindow(): void {
  createOrFocusSubWindow(
    {
      hash: '/logs',
      title: '小小牛马 - 工作日志',
      width: 560,
      height: 680,
    },
    () => logWindow,
    (win) => { logWindow = win }
  )
}

// ── 小工具窗口 ──────────────────────────────────
export function openToolWindow(): void {
  createOrFocusSubWindow(
    {
      hash: '/tools',
      title: '小小牛马 - 小工具',
      width: 520,
      height: 740,
    },
    () => toolWindow,
    (win) => { toolWindow = win }
  )
}

// ── 统一对话窗口（AI 对话 + Agent 模式合并） ─────
/**
 * 打开（或复用）统一对话窗口，路由 #/chat。
 * 顶部可在「快速对话 / Agent」两种模式间切换；
 * 尺寸/位置记忆到 config.chat_window_bounds。
 */
export function openChatWindow(): void {
  if (chatWindow && !chatWindow.isDestroyed()) {
    if (chatWindow.isMinimized()) chatWindow.restore()
    chatWindow.show()
    chatWindow.focus()
    chatWindow.webContents.send('main:chat-focus-input')
    return
  }

  const saved = getConfig().chat_window_bounds
  const winOpts: Electron.BrowserWindowConstructorOptions = {
    width: saved?.width ?? 1020,
    height: saved?.height ?? 750,
    minWidth: 800,
    minHeight: 550,
    title: '小小牛马 · 对话',
    resizable: true,
    backgroundColor: '#f7f5ef',
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 18, y: 18 },
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
  chatWindow = new BrowserWindow(winOpts)

  chatWindow.loadURL(getRendererURL('/chat'))

  let saveTimer: NodeJS.Timeout | null = null
  const saveBounds = () => {
    if (!chatWindow || chatWindow.isDestroyed()) return
    const b = chatWindow.getBounds()
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      setConfig({ chat_window_bounds: b })
    }, 300)
  }
  chatWindow.on('resize', saveBounds)
  chatWindow.on('move', saveBounds)

  chatWindow.on('closed', () => {
    chatWindow = null
    if (saveTimer) clearTimeout(saveTimer)
    // 窗口关闭时，强制中断所有活跃的后台对话及 Agent 执行
    try {
      import('./ipc-handlers-chat').then(({ abortAllActiveChats }) => {
        abortAllActiveChats()
      }).catch(err => {
        console.warn('[Window] 统一对话窗口关闭时中止后台服务失败:', err)
      })
    } catch (err) {
      console.warn('[Window] 统一对话窗口关闭时同步获取中止函数失败:', err)
    }
  })
}

export function getChatWindow(): BrowserWindow | null {
  return chatWindow
}

// ── Agent 技能管理窗口 ─────────────────────────
/**
 * 打开（或复用）技能管理窗口，独立路由 #/skills
 * 用于浏览/启停/安装内置与市场技能
 */
export function openSkillsWindow(): void {
  createOrFocusSubWindow(
    {
      hash: '/skills',
      title: '小小牛马 · 技能中心',
      width: 820,
      height: 680,
      minWidth: 560,
      minHeight: 480,
    },
    () => skillsWindow,
    (win) => { skillsWindow = win }
  )
}

export function getSkillsWindow(): BrowserWindow | null {
  return skillsWindow
}

// ── Agent Cron 管理窗口 ───────────────────────
export function openAgentCronWindow(): void {
  createOrFocusSubWindow(
    {
      hash: '/agent-cron',
      title: '小小牛马 · Agent Cron',
      width: 860,
      height: 720,
      minWidth: 620,
      minHeight: 520,
    },
    () => agentCronWindow,
    (win) => { agentCronWindow = win }
  )
}

export function getAgentCronWindow(): BrowserWindow | null {
  return agentCronWindow
}
