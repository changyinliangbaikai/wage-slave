---
description: 发布新版本流程
---

# 发布新版本流程

本 workflow 用于发布小小牛马的新版本，包括更新 CHANGELOG、提交代码、打 tag 并触发自动构建。

## 前置条件

- 确保当前在 main 分支
- 确保代码已提交并推送到远程
- 确认版本号已在 package.json 中更新

## 执行步骤

### 1. 更新 CHANGELOG.md

在项目根目录的 `CHANGELOG.md` 文件中添加新版本的更新内容：

```markdown
## [版本号] - 发布日期

### 新增功能
- 功能描述

### 改进
- 改进描述

### 修复
- 修复描述
```

**示例**：
```markdown
## [2.0.0] - 2026-04-14

### 新增功能
- 添加小工具箱功能
  - 错别字检查工具
  - 定时任务管理工具

### 改进
- 优化 GitHub Actions 自动构建和发布流程
- Release 内容自动从 CHANGELOG 读取
```

### 2. 提交并推送到 main 分支

```bash
git add CHANGELOG.md
git commit -m "docs: 更新 CHANGELOG - 版本号"
git push origin main
```

### 3. 打 tag 并推送

```bash
git tag v版本号
git push origin v版本号
```

**示例**：
```bash
git tag v2.0.0
git push origin v2.0.0
```

### 4. 验证发布

- 访问 GitHub 仓库的 Actions 页面，查看构建进度
- 构建完成后，在 Releases 页面查看新发布的版本
- 下载安装包测试功能

## 注意事项

- Tag 格式必须为 `v` 开头（如 `v1.0.0`、`v2.0.0-pre`）
- CHANGELOG.md 中的版本号格式应与 tag 保持一致（支持方括号包裹）
- 发布前确保 package.json 中的版本号已更新
- 如果是预发布版本，建议在版本号后添加 `-pre`、`-beta` 等后缀

## 回滚操作

如果发布有问题，可以删除 tag 并重新发布：

```bash
# 删除远程 tag
git push origin :refs/tags/v版本号

# 删除本地 tag
git tag -d v版本号

# 重新打 tag
git tag v新版本号
git push origin v新版本号
```
