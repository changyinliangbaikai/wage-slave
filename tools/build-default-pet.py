#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
将旧版 29 帧 sprite_all.png 重排为新的 12 帧标准布局，并生成 thumbnail。

旧布局（每帧 120×144 横向）：
  idle(4) | blink(5) | talk(5) | happy(4) | worried(3) | stretch(4) | sleep(4)
  对应索引：0-3 | 4-8 | 9-13 | 14-17 | 18-20 | 21-24 | 25-28

新布局（12 帧 × 120×144 = 1440×144）：
  idle×4 (0-3) | petting×2 (4-5) | celebrate×2 (6-7) | busy×4 (8-11)

映射：
  idle      ← 原 idle    (0,1,2,3)
  petting   ← 原 happy   (14,15)         # 取前 2 帧
  celebrate ← 原 stretch (21,23)         # 取第 0 / 第 2 帧让动作差异更大
  busy      ← 原 talk    (9,10,11,12)    # 取 talk 前 4 帧
"""

from PIL import Image
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "assets", "pixel_cat", "sprite_all.png")
DST_DIR = os.path.join(ROOT, "assets", "pets", "default-cat")
DST_SPRITE = os.path.join(DST_DIR, "sprite_all.png")
DST_THUMB = os.path.join(DST_DIR, "thumbnail.png")

FRAME_W = 120
FRAME_H = 144

# 旧帧索引 → 新帧索引
MAPPING = [
    # idle ×4
    (0, 0), (1, 1), (2, 2), (3, 3),
    # petting ×2 ← 原 happy 前两帧
    (14, 4), (15, 5),
    # celebrate ×2 ← 原 stretch 第 0 / 第 2 帧
    (21, 6), (23, 7),
    # busy ×4 ← 原 talk 前 4 帧
    (9, 8), (10, 9), (11, 10), (12, 11),
]

NEW_FRAMES = 12


def main() -> int:
    if not os.path.exists(SRC):
        print(f"[ERROR] 源 sprite 不存在: {SRC}", file=sys.stderr)
        return 1

    os.makedirs(DST_DIR, exist_ok=True)

    src_img = Image.open(SRC).convert("RGBA")
    sw, sh = src_img.size
    print(f"[INFO] 源 sprite 尺寸 {sw}x{sh}")
    if sh != FRAME_H or sw % FRAME_W != 0:
        print(f"[WARN] 源 sprite 帧尺寸不符（期望高 {FRAME_H}，宽是 {FRAME_W} 的倍数）", file=sys.stderr)

    # 创建新 sheet
    new_w = FRAME_W * NEW_FRAMES
    new_img = Image.new("RGBA", (new_w, FRAME_H), (0, 0, 0, 0))

    for old_idx, new_idx in MAPPING:
        sx = old_idx * FRAME_W
        crop = src_img.crop((sx, 0, sx + FRAME_W, FRAME_H))
        new_img.paste(crop, (new_idx * FRAME_W, 0), crop)
        print(f"[OK] 旧帧 {old_idx} → 新帧 {new_idx}")

    new_img.save(DST_SPRITE, "PNG")
    print(f"[DONE] 新 sprite 已写入 {DST_SPRITE} ({new_w}x{FRAME_H})")

    # thumbnail = 第 0 帧
    thumb = new_img.crop((0, 0, FRAME_W, FRAME_H))
    thumb.save(DST_THUMB, "PNG")
    print(f"[DONE] thumbnail 已写入 {DST_THUMB}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
