# -*- coding: utf-8 -*-
"""
照片换背景合成（本地 PIL，无 ML）
输入：imageseg SegmentHDBody 返回的 4 通道 alpha PNG + 背景图
流程：抠出人物 → 等比缩放到背景高度 85% → 底部居中贴到背景 → 输出 JPG
用法：
  python photo-bg-compose.py <alpha.png> <bg.jpg> <out.jpg>
"""
import sys
from PIL import Image


def compose(alpha_path: str, bg_path: str, out_path: str) -> None:
    img = Image.open(alpha_path).convert("RGBA")
    bbox = img.getchannel("A").getbbox()
    if not bbox:
        raise SystemExit("抠图结果为空（未检测到人体）")
    person = img.crop(bbox)

    bg = Image.open(bg_path).convert("RGB")
    # 背景统一处理成竖版 1080x1440（中心裁剪）
    TW, TH = 1080, 1440
    bw, bh = bg.size
    scale = max(TW / bw, TH / bh)
    bg = bg.resize((int(bw * scale) + 1, int(bh * scale) + 1), Image.LANCZOS)
    left = (bg.width - TW) // 2
    top = (bg.height - TH) // 2
    canvas = bg.crop((left, top, left + TW, top + TH))

    # 人物高度占 80%，底部留 4%
    target_h = int(TH * 0.80)
    s = target_h / person.height
    person = person.resize((int(person.width * s), target_h), Image.LANCZOS)
    if person.width > TW:
        s2 = TW / person.width
        person = person.resize((TW, int(person.height * s2)), Image.LANCZOS)

    x = (TW - person.width) // 2
    y = TH - person.height - int(TH * 0.04)
    canvas.paste(person, (x, y), person)
    canvas.save(out_path, "JPEG", quality=92)


if __name__ == "__main__":
    compose(sys.argv[1], sys.argv[2], sys.argv[3])
