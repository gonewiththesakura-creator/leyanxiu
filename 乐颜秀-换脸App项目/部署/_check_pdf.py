# -*- coding: utf-8 -*-
from pypdf import PdfReader
from pathlib import Path
import re

base = Path(r"REDACTED_LOCAL_USER_PATH\Documents\kimi\workspace\乐颜秀-换脸App项目\部署")
for name in ["算法安全自评估报告（备案提交版-含主体责任附件）.pdf",
             "算法安全自评估报告（备案提交版）.pdf",
             "拟公示内容（备案提交版）.pdf"]:
    r = PdfReader(str(base / name))
    text = "".join(p.extract_text() or "" for p in r.pages)
    print(name, "| 页数:", len(r.pages), "| 待插入佐证:", text.count("待插入佐证"))
    for m in sorted(set(re.findall(r"【[^】]{1,20}】", text))):
        print("   占位:", m, text.count(m))
