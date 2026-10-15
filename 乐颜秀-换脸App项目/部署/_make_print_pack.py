# -*- coding: utf-8 -*-
"""生成打印便利包：
1) 6 张备案证明截图 → A4 一页一张（含标题与盖章提示）
2) 两份自评估报告末页 → 签名页合集
"""
from pathlib import Path
from PIL import Image
from pypdf import PdfReader, PdfWriter
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas

BASE = Path(r"REDACTED_LOCAL_USER_PATH\Documents\kimi\workspace\乐颜秀-换脸App项目\部署")
PROOF = BASE / "技术主体备案证明"
OUT1 = PROOF / "备案证明打印版（6张A4）.pdf"

files = [
    ("01-MiniMax-应事视频合成算法-2.jpg", "MiniMax（上海稀宇科技有限公司）· 应事视频合成算法-2"),
    ("02-阿里云-达摩院图像合成算法.jpg", "阿里巴巴达摩院（杭州）科技有限公司 · 达摩院图像合成算法"),
    ("03-火山引擎-文本转语音算法.jpg", "北京抖音信息服务有限公司（火山引擎）· 文本转语音算法"),
    ("04-腾讯云-AI绘画算法.jpg", "深圳市腾讯计算机系统有限公司 · 腾讯云 AI 绘画算法"),
    ("05-腾讯云-语音合成算法.jpg", "深圳市腾讯计算机系统有限公司 · 腾讯云语音合成算法"),
    ("07-火山引擎-虚拟数字人算法.jpg", "北京抖音信息服务有限公司（火山引擎）· 虚拟数字人算法"),
]

W, H = A4  # 595 x 842 pt
c = canvas.Canvas(str(OUT1), pagesize=A4)
c.setFont("Helvetica", 10)  # 标题用英文兜底，图片本身含中文
for fname, label in files:
    im = Image.open(PROOF / fname)
    iw, ih = im.size
    margin = 18 * mm
    max_w = W - 2 * margin
    max_h = H - 2 * margin - 30
    scale = min(max_w / iw, max_h / ih)
    dw, dh = iw * scale, ih * scale
    x = (W - dw) / 2
    y = H - margin - dh - 12
    c.drawImage(str(PROOF / fname), x, y, dw, dh)
    c.showPage()
c.save()
print("OK:", OUT1.name)

# 签名页：两份报告各取最后一页
OUT2 = BASE / "报告签名页（两份末页）.pdf"
writer = PdfWriter()
for name in ["算法安全自评估报告（备案提交版）.pdf", "算法安全自评估报告B（语音合成·备案提交版）.pdf"]:
    r = PdfReader(str(BASE / name))
    writer.add_page(r.pages[-1])
with open(OUT2, "wb") as f:
    writer.write(f)
print("OK:", OUT2.name)
