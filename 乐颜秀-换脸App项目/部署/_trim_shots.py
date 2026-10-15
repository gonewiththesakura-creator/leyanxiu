# -*- coding: utf-8 -*-
"""裁掉佐证截图底部的大片背景空白，保留少量边距。"""
from pathlib import Path
from PIL import Image
import numpy as np

DIR = Path(r"REDACTED_LOCAL_USER_PATH\Documents\kimi\workspace\乐颜秀-换脸App项目\部署\_evidence-pages-截图")

for png in sorted(DIR.glob("*.png")):
    im = Image.open(png).convert("RGB")
    a = np.asarray(im).astype(int)
    bg = a[-5:, -5:].reshape(-1, 3).mean(axis=0)  # 取右下角作背景色
    diff = np.abs(a - bg).sum(axis=2)  # 每像素与背景的差异
    rows = np.where(diff.max(axis=1) > 30)[0]
    if len(rows) == 0:
        print(png.name, "skip (blank)")
        continue
    bottom = min(rows[-1] + 24, a.shape[0])  # 内容末尾 + 12px 边距（2x 缩放）
    im.crop((0, 0, a.shape[1], bottom)).save(png)
    print(png.name, f"{a.shape[1]}x{a.shape[0]} -> {a.shape[1]}x{bottom}")
