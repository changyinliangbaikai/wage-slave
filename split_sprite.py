#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Sprite图片切割脚本
将sprite_happy.png中的4个猫表情切割成单独的图片
"""

from PIL import Image
import os

# 配置参数
SPRITE_PATH = "assets/pixel_cat/sprite_happy.png"
OUTPUT_DIR = "docs/imgs"
CAT_COUNT = 4  # 猫的数量

def split_sprite():
    """
    切割sprite图片
    """
    print(f"开始处理sprite图片: {SPRITE_PATH}")
    
    # 检查源文件是否存在
    if not os.path.exists(SPRITE_PATH):
        print(f"错误: 源文件 {SPRITE_PATH} 不存在")
        return
    
    # 创建输出目录
    if not os.path.exists(OUTPUT_DIR):
        os.makedirs(OUTPUT_DIR)
        print(f"创建输出目录: {OUTPUT_DIR}")
    
    # 打开图片
    img = Image.open(SPRITE_PATH)
    width, height = img.size
    print(f"原始图片尺寸: {width}x{height}")
    
    # 计算每个猫的宽度
    cat_width = width // CAT_COUNT
    print(f"每个猫的宽度: {cat_width}")
    
    # 切割并保存每个猫的图片
    for i in range(CAT_COUNT):
        # 计算切割区域 (left, top, right, bottom)
        left = i * cat_width
        top = 0
        right = (i + 1) * cat_width
        bottom = height
        
        print(f"切割第 {i+1} 个猫: 区域 ({left}, {top}, {right}, {bottom})")
        
        # 切割图片
        cat_img = img.crop((left, top, right, bottom))
        
        # 保存图片
        output_path = os.path.join(OUTPUT_DIR, f"cat_happy_{i+1}.png")
        cat_img.save(output_path)
        print(f"保存图片: {output_path}")
    
    print(f"完成! 共切割 {CAT_COUNT} 个猫图片到 {OUTPUT_DIR}")

if __name__ == "__main__":
    split_sprite()
