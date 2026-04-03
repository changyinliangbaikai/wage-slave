/**
 * 系统托盘模块
 */

import { Tray, Menu, nativeImage, app } from 'electron'
import path from 'path'
import { showMainWindow, openSettingsWindow } from './windows'

let tray: Tray | null = null

export function createTray(): Tray {
  // 使用像素猫头像作为托盘图标（16×16 或 32×32）
  const iconPath = path.join(__dirname, '../../assets/tray-icon.png')
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
      label: '📋 查看今日待办',
      click: () => {
        showMainWindow()
        // 通知渲染进程展开待办清单
        const { getMainWindow } = require('./windows')
        getMainWindow()?.webContents.send('main:show-todos')
      },
    },
    {
      label: '📝 录入工作日志',
      click: () => {
        showMainWindow()
        const { getMainWindow } = require('./windows')
        getMainWindow()?.webContents.send('main:trigger-manual-log')
      },
    },
    {
      label: '📊 生成工作总结',
      click: () => {
        showMainWindow()
        const { getMainWindow } = require('./windows')
        getMainWindow()?.webContents.send('main:trigger-summary')
      },
    },
    { type: 'separator' },
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
