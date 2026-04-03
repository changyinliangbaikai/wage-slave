/**
 * 窗口管理模块
 * 负责创建透明无边框置顶窗口，处理拖动和边缘收起逻辑
 */

import { BrowserWindow, screen, app, ipcMain } from 'electron'
import path from 'path'
import { getConfig, setConfig } from './store'

const EDGE_THRESHOLD = 20   // 距屏幕边缘多少像素触发收起
const CAT_W = 140           // 猫咪窗口宽度
const CAT_H = 180           // 猫咪窗口高度（含气泡展开余量）
const HIDDEN_PEEK = 8       // 收起后露出的像素数（猫耳）

let mainWindow: BrowserWindow | null = null
let settingsWindow: BrowserWindow | null = null

const isDev = !app.isPackaged

function getRendererURL(page = ''): string {
  if (isDev) {
    return `http://localhost:5173/${page}`
  }
  return `file://${path.join(__dirname, '../../dist/index.html')}${page ? `#${page}` : ''}`
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
  mainWindow.setIgnoreMouseEvents(false)

  // 注册窗口拖动 IPC（手动实现拖动）
  ipcMain.on('window:drag-start', () => {
    if (mainWindow) {
      mainWindow.setIgnoreMouseEvents(true)
    }
  })

  ipcMain.on('window:drag-move', (_e, deltaX: number, deltaY: number) => {
    if (mainWindow) {
      const [wx, wy] = mainWindow.getPosition()
      mainWindow.setPosition(wx + deltaX, wy + deltaY)
    }
  })

  ipcMain.on('window:drag-end', () => {
    if (mainWindow) {
      mainWindow.setIgnoreMouseEvents(false)
      const [wx, wy] = mainWindow.getPosition()
      setConfig({ cat_position: { x: wx, y: wy } })
      checkEdgeHide(wx, wy)
    }
  })

  // 拖动结束后保存位置
  mainWindow.on('moved', () => {
    if (!mainWindow) return
    const [wx, wy] = mainWindow.getPosition()
    setConfig({ cat_position: { x: wx, y: wy } })
    checkEdgeHide(wx, wy)
  })

  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  }

  return mainWindow
}

/** 检查是否拖到屏幕边缘，触发收起 */
function checkEdgeHide(wx: number, wy: number): void {
  if (!mainWindow) return
  const display = screen.getDisplayNearestPoint({ x: wx, y: wy })
  const { x: dx, y: dy, width: dw, height: dh } = display.workArea

  const nearLeft   = wx - dx < EDGE_THRESHOLD
  const nearRight  = (dx + dw) - (wx + CAT_W) < EDGE_THRESHOLD
  const nearTop    = wy - dy < EDGE_THRESHOLD
  const nearBottom = (dy + dh) - (wy + CAT_H) < EDGE_THRESHOLD

  if (nearLeft) {
    mainWindow.setPosition(dx - CAT_W + HIDDEN_PEEK, wy)
    setConfig({ cat_hidden: true })
  } else if (nearRight) {
    mainWindow.setPosition(dx + dw - HIDDEN_PEEK, wy)
    setConfig({ cat_hidden: true })
  } else if (nearTop) {
    mainWindow.setPosition(wx, dy - CAT_H + HIDDEN_PEEK)
    setConfig({ cat_hidden: true })
  } else if (nearBottom) {
    mainWindow.setPosition(wx, dy + dh - HIDDEN_PEEK)
    setConfig({ cat_hidden: true })
  } else {
    setConfig({ cat_hidden: false })
  }
}

/** 从托盘/鼠标悬停时把猫展开回来 */
export function showMainWindow(): void {
  if (!mainWindow) return
  const display = screen.getPrimaryDisplay()
  const { width: sw, height: sh } = display.workAreaSize
  mainWindow.setPosition(sw - CAT_W - 20, sh - CAT_H - 20)
  mainWindow.show()
  setConfig({ cat_hidden: false, cat_position: { x: sw - CAT_W - 20, y: sh - CAT_H - 20 } })
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
    height: 620,
    title: '小小牛马 - 设置',
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  settingsWindow.loadURL(getRendererURL('#/settings'))

  settingsWindow.on('closed', () => {
    settingsWindow = null
  })
}
