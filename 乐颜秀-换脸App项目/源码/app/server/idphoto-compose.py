# -*- coding: utf-8 -*-
"""
证件照合成（本地 PIL，无 ML）
输入：imageseg SegmentHDBody 返回的 4 通道 alpha PNG
流程：抠出人物 → 按证件照规范缩放居中 → 贴到纯色底 → 输出单张/6寸排版
用法：
  python idphoto-compose.py <alpha.png> <out.jpg> --bg white|red|blue \
      --size 1寸|2寸|小2寸 [--layout6]
"""
import argparse
import sys
from PIL import Image

# 背景色（证件照标准色）
BG_COLORS = {
    "white": (255, 255, 255),
    "red":   (255, 0, 0),      # 常用红底
    "blue":  (67, 142, 219),   # 常用蓝底
}

# 尺寸（300dpi 像素）
SIZES = {
    "1寸":  (295, 413),
    "2寸":  (413, 579),
    "小2寸": (413, 531),  # 护照规格
}

# 6寸相纸（300dpi）
PAPER_6IN = (1795, 1205)


def compose(alpha_path: str, out_path: str, bg: str, size_name: str, layout6: bool) -> None:
    img = Image.open(alpha_path).convert("RGBA")
    bbox = img.getchannel("A").getbbox()
    if not bbox:
        raise SystemExit("抠图结果为空（未检测到人体）")
    person = img.crop(bbox)

    pw, ph = SIZES[size_name]
    # 人物高度约占照片 78%，头顶留边 6%（证件照常用比例）
    target_h = int(ph * 0.78)
    scale = target_h / person.height
    person = person.resize((int(person.width * scale), target_h), Image.LANCZOS)
    if person.width > pw:
        s = pw / person.width
        person = person.resize((pw, int(person.height * s)), Image.LANCZOS)

    canvas = Image.new("RGB", (pw, ph), BG_COLORS[bg])
    x = (pw - person.width) // 2
    y = int(ph * 0.06)
    canvas.paste(person, (x, y), person)

    if not layout6:
        canvas.save(out_path, "JPEG", quality=95)
        return

    # 6寸相纸排版：横放照片，带边距平铺
    paper = Image.new("RGB", PAPER_6IN, (255, 255, 255))
    tw, th = ph, pw  # 横排更省纸
    photo = canvas.rotate(90, expand=True)
    margin, gap = 40, 20
    cols = (PAPER_6IN[0] - margin * 2 + gap) // (tw + gap)
    rows = (PAPER_6IN[1] - margin * 2 + gap) // (th + gap)
    for r in range(rows):
        for c_ in range(cols):
            paper.paste(photo, (margin + c_ * (tw + gap), margin + r * (th + gap)))
    paper.save(out_path, "JPEG", quality=95)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("alpha")
    ap.add_argument("out")
    ap.add_argument("--bg", default="white", choices=list(BG_COLORS))
    ap.add_argument("--size", default="1寸", choices=list(SIZES))
    ap.add_argument("--layout6", action="store_true", help="输出6寸相纸排版")
    a = ap.parse_args()
    compose(a.alpha, a.out, a.bg, a.size, a.layout6)
    print("OK", a.out)
