#!/bin/bash
# 小小牛马 - Mac 开发环境快速启动脚本

set -e

echo "🐱 小小牛马 开发环境启动..."
echo ""

# 检查 Node.js 版本
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo "❌ 需要 Node.js >= 18，当前版本：$(node -v)"
  exit 1
fi

# 首次安装依赖
if [ ! -d "node_modules" ]; then
  echo "📦 首次安装依赖（需要几分钟）..."
  npm install
  echo "✅ 依赖安装完成"
  echo ""
fi

# Mac 上辅助功能权限提示
echo "⚠️  提示：休息提醒功能需要「辅助功能」权限"
echo "   如弹出权限请求，请在「系统设置 → 隐私与安全性 → 辅助功能」中允许"
echo "   若暂不授权，休息提醒功能将以降级模式运行（不影响其他功能）"
echo ""

# 启动开发模式
echo "🚀 启动开发模式..."
echo "   窗口出现后，像素猫会显示在屏幕角落"
echo "   右键托盘图标 → 设置，填写 LLM API 信息"
echo ""

npm run dev
