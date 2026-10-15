# -*- coding: utf-8 -*-
"""打包 A+B 备案全套材料（发老板版）。"""
import zipfile
from pathlib import Path

BASE = Path(r"REDACTED_LOCAL_USER_PATH\Documents\kimi\workspace\乐颜秀-换脸App项目\部署")
OUT = BASE / "乐颜秀备案材料包-2026-08-07.zip"

files = {
    "A备案-图像视频/算法安全自评估报告（备案提交版-含主体责任附件）.docx": "算法安全自评估报告（备案提交版-含主体责任附件）.docx",
    "A备案-图像视频/算法安全自评估报告（备案提交版-含主体责任附件）.pdf": "算法安全自评估报告（备案提交版-含主体责任附件）.pdf",
    "A备案-图像视频/拟公示内容（备案提交版）.docx": "拟公示内容（备案提交版）.docx",
    "A备案-图像视频/拟公示内容（备案提交版）.pdf": "拟公示内容（备案提交版）.pdf",
    "B备案-语音合成/算法安全自评估报告B（语音合成·备案提交版-含主体责任附件）.docx": "算法安全自评估报告B（语音合成·备案提交版-含主体责任附件）.docx",
    "B备案-语音合成/算法安全自评估报告B（语音合成·备案提交版-含主体责任附件）.pdf": "算法安全自评估报告B（语音合成·备案提交版-含主体责任附件）.pdf",
    "B备案-语音合成/拟公示内容B（语音合成·备案提交版）.docx": "拟公示内容B（语音合成·备案提交版）.docx",
    "B备案-语音合成/拟公示内容B（语音合成·备案提交版）.pdf": "拟公示内容B（语音合成·备案提交版）.pdf",
    "B备案-语音合成/深度合成备案材料B（语音合成·填报工作稿）.docx": "深度合成备案材料B（语音合成）.docx",
    "B备案-语音合成/深度合成备案材料B（语音合成·填报工作稿）.pdf": "深度合成备案材料B（语音合成）.pdf",
    "公司方需办理事项清单.docx": "公司方需办理事项清单.docx",
}

with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
    for arc, src in files.items():
        p = BASE / src
        assert p.exists(), f"缺失: {src}"
        z.write(p, arc)
print("OK:", OUT, f"{OUT.stat().st_size/1024/1024:.1f} MB, {len(files)} 个文件")
