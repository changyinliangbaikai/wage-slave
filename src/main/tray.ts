/**
 * 系统托盘模块
 */

import { Tray, Menu, nativeImage, app } from 'electron'
import path from 'path'
import { showMainWindow, openSettingsWindow, openLogWindow, getMainWindow, openChatWindow } from './windows'

let tray: Tray | null = null

export function createTray(): Tray {
  // 使用像素猫头像作为托盘图标
  // 开发环境从项目根目录加载，生产环境从 resources 加载
  const isDev = !app.isPackaged
  const iconPath = isDev
    ? path.join(__dirname, '../../assets/tray-icon.png')
    : path.join(process.resourcesPath, 'pets', 'tray-icon.png')
  const icon = nativeImage.createFromPath(iconPath)

  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  tray.setToolTip('小小牛马')

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '🐱 显示小猫',
      click: () => showMainWindow(),
    },
    { type: 'separator' },
    {
      label: '☀️ 录入今日计划',
      click: () => {
        showMainWindow()
        getMainWindow()?.webContents.send('main:trigger-morning-plan')
      },
    },
    {
      label: '📋 查看今日待办',
      click: () => {
        showMainWindow()
        getMainWindow()?.webContents.send('main:show-todos')
      },
    },
    {
      label: '📝 录入工作日志',
      click: () => {
        showMainWindow()
        getMainWindow()?.webContents.send('main:trigger-manual-log')
      },
    },
    {
      label: '📊 生成工作总结',
      click: () => {
        showMainWindow()
        getMainWindow()?.webContents.send('main:trigger-summary')
      },
    },
    { type: 'separator' },
    {
      label: '💬 对话（AI / Agent）',
      click: () => openChatWindow(),
    },
    {
      label: '📒 查看工作日志',
      click: () => openLogWindow(),
    },
    {
      label: '⚙️ 设置',
      click: () => openSettingsWindow(),
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => app.quit(),
    },
  ])

  tray.setContextMenu(contextMenu)

  // 左键单击直接显示猫
  tray.on('click', () => showMainWindow())

  return tray
}

export function getTray(): Tray | null {
  return tray
}
