# 桌宠包（Pet Pack）规范 v1

> 一份用来描述「桌宠长什么样、怎么动」的资源包格式。  
> 让任何人都能用一张 PNG 换装自己的桌宠。

---

## 一、最快上手（5 步换装）

1. 打开「设置 → 桌宠外观」
2. 复制 AI 提示词卡片里的内容，粘贴到 ChatGPT / Gemini / Claude 等 AI 工具，让它给你生成一张 sprite sheet
3. 把 AI 生成的图保存为 **`.png`**（透明背景、尺寸不必严格是 1440×144）
4. 点击「+ 上传 sprite sheet」，选择刚才那张 PNG
5. 在弹出的裁切弹窗里拖拽 4 边手柄，让 11 条竖线把 12 个帧均匀分开
6. 给桌宠起个名字，点「确认导入」→ 系统自动切片 + 立刻换装

UI 完全不需要你看下面的字段说明。下面的内容是给想做更复杂桌宠包（比如帧序列、自定义 fps）的高级用户。

---

## 二、推荐 sprite sheet 布局

```
┌──────────── 1440 × 144 px (12 frames × 120×144) ───────────┐
│ idle ×4  │ petting ×2 │ celebrate ×2 │     busy ×4         │
│  (loop)  │  (loop)    │ (one-shot)   │     (loop)          │
│  2 fps   │  5 fps     │  5 fps       │     6 fps           │
└────────────────────────────────────────────────────────────┘
   frame 0-3   frame 4-5   frame 6-7      frame 8-11
```

> 导入弹窗支持任意尺寸裁切，上表只是「思考参考」，实际裁切后的帧宽/帧高会被写入 manifest，渲染引擎能正确出图。

| 段 | 帧索引 | 用途 | 业务场景 |
|---|---|---|---|
| `idle` | 0–3 | 空闲循环（呼吸/眨眼） | 默认状态 |
| `petting` | 4–5 | 被点击/抚摸/喂食的轻量反应 | 用户与小猫互动时 |
| `celebrate` | 6–7 | 完成任务/计划庆祝 | 勾完一天待办、晚间复盘完成率高 |
| `busy` | 8–11 | 工作中循环 | LLM 调用、流式生成、解析计划 |

- 推荐每帧 **120 × 144 像素**（比例 5：6）
- 推荐整图 **1440 × 144 像素**（或者任何宽能被 12 整除、高比例接近的尺寸）
- 裁切后帧宽范围 **16 – 1024 像素**
- 必须是 **PNG**、**透明背景**（alpha channel）
- 相邻帧紧贴、不要留间隔条
- 单文件大小 ≤ **8 MB**

---

## 三、AI 生图建议

把这段提示词改成你想要的风格后发给 AI（设置页内有一键复制按钮）：

```
请生成一张桌宠角色 sprite sheet，规格如下：

- 总尺寸 1440×144 像素，PNG 格式，透明背景（alpha channel）
- 横向排列共 12 帧，每帧 120×144 像素，相邻帧紧贴无间隔、严格对齐
- 帧序与动作要求：
  · 第 1–4 帧：【空闲循环】角色站立时的轻微呼吸或眨眼
  · 第 5–6 帧：【被点击反应】角色对用户触摸的轻量回应（眨眼/微笑）
  · 第 7–8 帧：【完成任务庆祝】一次性动作（举手/小跳/转圈）
  · 第 9–12 帧：【工作中循环】角色敲键盘/搬运物品/低头思考
- 同一角色贯穿全部 12 帧，动作连贯，姿态清晰可识别
- 角色面朝画面正前方，下方留出少量阴影或站立面
- 画风风格：{userStyle}
- 严格按帧间距对齐，不要在帧之间留空白条
```

**推荐风格关键词**：卡通像素风 / 赛博朋克 / 水墨国风 / Q 版可爱 / 复古像素 / 现代扁平 / 手绘漫画

**常见生图踩坑**：
- AI 经常忘记"透明背景" → 提示词里强调 `transparent alpha channel`；生图后用 PS / GIMP 把白底换成透明
- AI 容易把帧间距画歪 → 导入弹窗里拖拽 4 边，让 11 条辅助线对准实际的帧边界即可
- AI 不会真正画 12 帧动画 → 接受这点；同一角色的 12 个相似姿态已经够"动"起来了
- AI 输出的总尺寸带外边距 / 水印 / 额外背景色块 → 裁切弹窗中拖动 4 边裁掉

---

## 四、桌宠包目录结构

设置页上传 sprite 时会**自动**生成完整包结构，你不需要手动建：

```
{userData}/pets/<id>/
├── manifest.json          ← 自动生成
├── sprite_all.png         ← 你上传的 PNG
└── thumbnail.png          ← 自动生成（默认 = sprite_all 副本）
```

`<id>` 由桌宠名称自动转换（小写、空格转 `-`）；若冲突则递增编号。

**推荐桌宠包目录路径**：
- macOS: `~/Library/Application Support/xiao-niu-ma/pets/`
- Windows: `%APPDATA%\xiao-niu-ma\pets\`

设置页里有「打开桌宠目录」按钮可直接打开。

---

## 五、manifest.json 字段说明（高级）

普通用户只用上传 PNG 就够了；本节针对想做 `.zip` 包分发的作者。

### 5.1 完整示例

```json
{
  "schema": "xiaoniu-pet/v1",
  "id": "my-cat",
  "name": "我的桌宠",
  "version": "1.0.0",
  "author": "John",
  "description": "可选描述",
  "thumbnail": "thumbnail.png",
  "frame": { "width": 120, "height": 144, "displayScale": 0.75 },
  "fallback": "idle",
  "animations": {
    "idle":      { "type": "sprite", "source": "sprite_all.png", "startFrame": 0, "frameCount": 4, "fps": 2, "loop": true,  "layout": "horizontal" },
    "petting":   { "type": "sprite", "source": "sprite_all.png", "startFrame": 4, "frameCount": 2, "fps": 5, "loop": true },
    "celebrate": { "type": "sprite", "source": "sprite_all.png", "startFrame": 6, "frameCount": 2, "fps": 5, "loop": false },
    "busy":      { "type": "sprite", "source": "sprite_all.png", "startFrame": 8, "frameCount": 4, "fps": 6, "loop": true }
  }
}
```

### 5.2 字段总览

| 字段 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `schema` | ✓ | `"xiaoniu-pet/v1"` | 固定字符串 |
| `id` | ✓ | string | 匹配 `^[a-z0-9_-]{1,64}$`；决定目录名 |
| `name` | ✓ | string | 在设置页显示的名称 |
| `version` | ✓ | string | 语义化版本号 |
| `author` | – | string | 作者名 |
| `description` | – | string | 简介 |
| `thumbnail` | – | string | 缩略图相对路径 |
| `frame.width` | ✓ | number | 单帧像素宽 |
| `frame.height` | ✓ | number | 单帧像素高 |
| `frame.displayScale` | – | number | 显示缩放，默认 `0.75` |
| `fallback` | – | CatState | 缺失动画时的回退状态，默认 `"idle"` |
| `animations` | ✓ | object | 动画字典；**仅 `idle` 必填** |

### 5.3 动画字段

#### 5.3.1 sprite 模式

```json
{
  "type": "sprite",
  "source": "sprite_all.png",
  "startFrame": 0,
  "frameCount": 4,
  "fps": 2,
  "loop": true,
  "layout": "horizontal"
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `type` | ✓ | `"sprite"` |
| `source` | ✓ | 相对包根的 sprite sheet 路径 |
| `startFrame` | ✓ | 起始帧索引（从 0 开始） |
| `frameCount` | ✓ | 连续帧数 |
| `fps` | ✓ | 帧率 |
| `loop` | ✓ | `true` 循环；`false` 播完回 `fallback`/`idle` |
| `layout` | – | `"horizontal"`（默认）或 `"vertical"` |

#### 5.3.2 frames 模式（独立帧序列）

```json
{
  "type": "frames",
  "frames": [
    "frames/celebrate/0.png",
    "frames/celebrate/1.png",
    "frames/celebrate/2.png"
  ],
  "fps": 5,
  "loop": false
}
```

适合做：
- 帧间形变较大、不适合切片对齐的动画
- 高分辨率原图（每帧 256×256+）
- AI 单图生成多动作时（每帧独立出图，不强求对齐）

注意：所有帧 URL 必须是包内相对路径，**禁止** `..`、绝对路径、`http://`、`file://`。

### 5.4 状态回退

业务代码会调用以下 4 个状态：

```
idle | petting | celebrate | busy
```

**只有 `idle` 必填**。其余 3 个缺失时，引擎会自动回退到 `fallback`（默认 `idle`）并打 warn 日志。

例如：你只画了 `idle` 和 `busy`：

```json
{
  "animations": {
    "idle": { ... },
    "busy": { ... }
  }
}
```

此时 `petting` / `celebrate` 触发都会播 `idle` 动画。能用，只是表现单调。

### 5.5 打包成 .zip

打包方式：把整个目录（含 `manifest.json` 与所有资源）压缩为 `.zip`。

约束：
- 单个 zip ≤ **50 MB**
- 文件名白名单：`.png .jpg .jpeg .webp .gif .json`
- 不允许包含路径穿越（`..` / 绝对路径 / 多个根目录）
- `manifest.id` 不能是 `default-cat`（保留给内置）
- id 冲突时自动递增编号

设置页「高级 → 导入 .zip 桌宠包」可一键导入。

---

## 六、推荐工具

| 用途 | 工具 | 说明 |
|---|---|---|
| 像素风创作 | [Aseprite](https://www.aseprite.org/) | 业界标准，原生支持 sprite sheet 导出 |
| 免费替代 | [LibreSprite](https://libresprite.github.io/) | Aseprite 的 fork，免费 |
| 通用绘图 | [Krita](https://krita.org/) | 免费，支持图层与时间轴 |
| 透明背景处理 | Photopea / GIMP | 网页/桌面，把 AI 生成的白底转透明 |
| AI 生图 | ChatGPT (DALL-E 3) / Gemini / Claude / Midjourney | 配合本仓库的提示词模板使用 |

---

## 七、常见问题

**Q: 我上传 PNG 后提示「图片尺寸不符合规范」？**  
A: 现在不再需要严格匹配 1440 × 144。导入弹窗允许你拖动 4 边手柄裁切出你想要的 12 帧区域，系统会自动按裁切后的宽度等分 12 份。

**Q: 桌宠没有透明背景，下面有方块？**  
A: PNG 必须有 alpha 通道。如果导出时是白底，用 GIMP 的「选择 → 按颜色 → 删除」把白色像素清掉。

**Q: 我画了 12 帧但动画看起来还是不动？**  
A: 确认每帧之间的姿态有差异。仅 2 帧的 petting/celebrate 也能"动"，关键是两帧之间确实有变化（例如：眼睛开/闭、手举起/放下）。

**Q: 能不能把 PNG 换成 WebP / AVIF？**  
A: 当前主入口只接受 PNG。`frames` 模式的高级路径支持 `.jpg .jpeg .webp .gif`。

**Q: 我想分享自己的桌宠包给朋友？**  
A: 把 `{userData}/pets/<id>/` 整个目录打成 zip 发给朋友，让 ta 在设置页「高级 → 导入 .zip」即可。

**Q: 怎么恢复默认像素猫？**  
A: 在设置页桌宠网格里点击「默认像素猫」卡片即可。删除当前激活的用户包时也会自动回退。
