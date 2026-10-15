from __future__ import annotations

import csv
import hashlib
import os
import re
import textwrap
import unicodedata
from io import BytesIO
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable
from xml.sax.saxutils import escape

from docx import Document
from docx.enum.section import WD_SECTION
from docx.enum.table import WD_ALIGN_VERTICAL, WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Inches, Pt, RGBColor
from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import cm
from reportlab.platypus import Image as RLImage, Paragraph as RLParagraph, Table as RLTable, TableStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from PIL import Image


ROOT = Path(r"D:\Documents\kimi\workspace\乐颜秀-换脸App项目\源码\app")
OUT = Path(r"D:\Documents\kimi\workspace\乐颜秀-换脸App项目\部署\软件著作权登记材料-2026-09-08")
OUT.mkdir(parents=True, exist_ok=True)
WORK = OUT / "_work"
WORK.mkdir(parents=True, exist_ok=True)

SOFTWARE_NAME = "乐颜秀AI影像创作软件"
SHORT_NAME = "乐颜秀"
VERSION = "V1.0"
ANDROID_VERSION = "1.0.0"
OWNER = "REDACTED_COMPANY_NAME"
USCC = "REDACTED_COMPANY_REGISTRATION"
PACKAGE_ID = "com.yibohuaxia.leyanxiu"
COMPLETION_DATE = "2026年9月6日"
DOCUMENT_DATE = "2026年9月9日"

GUIDE_DOCX = WORK / "乐颜秀软件著作权登记填报与材料清单-2026-09-08.docx"
MANUAL_DOCX = WORK / f"{SOFTWARE_NAME}{VERSION}-用户操作说明书.docx"
SOURCE_PDF = OUT / f"{SOFTWARE_NAME}{VERSION}-源程序鉴别材料.pdf"
MANUAL_PDF = OUT / f"{SOFTWARE_NAME}{VERSION}-用户操作说明书.pdf"
INVENTORY_CSV = OUT / "源程序文件清单与行数统计.csv"
PACKAGE_NOTE = OUT / "材料包使用说明.txt"
FILL_TXT = OUT / "R11软件著作权登记填报内容-直接粘贴.txt"
HASHES_TXT = OUT / "SHA256校验值.txt"

FONT_SONG = "SimSun"
FONT_HEI = "SimHei"
COLOR_NAVY = "24364B"
COLOR_BLUE = "2B6CB0"
COLOR_LIGHT = "EAF1F8"
COLOR_PALE = "F6F8FA"
COLOR_BORDER = "D9D9D9"
COLOR_TEXT = "202124"
COLOR_MUTED = "5F6368"


MAIN_FUNCTIONS = (
    "乐颜秀是一款面向成年用户的Android端AI影像创作软件，围绕用户主动选择的本人照片或已取得授权的照片，"
    "提供视频模板浏览、照片驱动视频创作、图片风格化、旧照修复、作品保存与分享等功能。软件启动后先展示隐私说明，"
    "用户可选择同意后进入在线创作，也可在不同意的情况下仅浏览本地模板。首页设置推荐、视频玩法、精选、百变图片和我的五个导航入口。"
    "精选页以单屏视频模板形式展示效果，支持上下滑动逐个切换、自动预览和声音控制；推荐页按编辑推荐、经典精选和最近上新组织模板；"
    "视频玩法按唱歌、跳舞和语录分类展示。用户进入模板详情后可先观看动态样片，再从系统相册选择照片或调用相机拍摄，确认照片内容、处理目的、"
    "服务商和保存期限后提交生成。百变图片将功能划分为时光穿越、国风大片、艺术风格和修复焕新，包含年龄变化、年代写真、国风肖像、"
    "漫画、水彩、油画、AI头像、清晰修复、黑白上色、高清放大和划痕修复等效果；年龄变化采用一个入口选择目标年龄，减少重复功能。"
    "服务端对上传媒体进行格式、大小和内容检查，创建异步任务并按功能路由至已配置的图像或视频处理服务。客户端轮询任务状态，"
    "在网络中断或应用切换后可恢复未完成任务，防止重复提交。生成完成后，软件显示带AI标识的图片或视频，用户可保存到系统相册、"
    "调用系统分享面板或生成自然的分享文案。我的页面用于查看和删除作品、查询服务与合规信息、提交问题反馈、撤回授权以及发起账号注销和数据删除。"
    "软件通过设备密钥验证、最小权限调用、传输校验、任务归属控制、访问日志、保存期限控制和失败关闭机制保护用户照片及生成结果。"
)

TECH_FEATURES = (
    "采用React、TypeScript与Capacitor构建Android客户端，Node.js服务端统一处理异步任务和多模型适配；"
    "支持断点恢复、隐私同意、最小权限访问、AI内容标识与作品管理。"
)

SHORT_FIELDS = {
    "开发的硬件环境": "x86-64个人计算机，8GB以上内存",
    "运行的硬件环境": "Android智能手机，64位ARM处理器，4GB以上内存",
    "开发该软件的操作系统": "Windows 11 64位",
    "软件开发环境/开发工具": "VS Code、Node.js、npm、Vite、Android Studio、Gradle",
    "该软件的运行平台/操作系统": "Android 7.0及以上版本",
    "软件运行支持环境/支持软件": "Android System WebView；Node.js服务端",
    "开发目的": "为用户提供基于照片的AI视频与图片创作、作品管理和分享服务",
    "面向领域/行业": "互联网和相关服务；数字内容服务",
}

assert 500 <= len(MAIN_FUNCTIONS) <= 1300, len(MAIN_FUNCTIONS)
assert len(TECH_FEATURES) <= 100, len(TECH_FEATURES)
for field_name, field_value in SHORT_FIELDS.items():
    assert len(field_value) <= 50, (field_name, len(field_value))


def set_cell_shading(cell, fill: str) -> None:
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = tc_pr.find(qn("w:shd"))
    if shd is None:
        shd = OxmlElement("w:shd")
        tc_pr.append(shd)
    shd.set(qn("w:fill"), fill)


def set_cell_margins(cell, top=110, start=130, bottom=110, end=130) -> None:
    tc = cell._tc
    tc_pr = tc.get_or_add_tcPr()
    tc_mar = tc_pr.first_child_found_in("w:tcMar")
    if tc_mar is None:
        tc_mar = OxmlElement("w:tcMar")
        tc_pr.append(tc_mar)
    for margin, value in (("top", top), ("start", start), ("bottom", bottom), ("end", end)):
        node = tc_mar.find(qn(f"w:{margin}"))
        if node is None:
            node = OxmlElement(f"w:{margin}")
            tc_mar.append(node)
        node.set(qn("w:w"), str(value))
        node.set(qn("w:type"), "dxa")


def set_repeat_table_header(row) -> None:
    tr_pr = row._tr.get_or_add_trPr()
    tbl_header = OxmlElement("w:tblHeader")
    tbl_header.set(qn("w:val"), "true")
    tr_pr.append(tbl_header)


def set_table_borders(table, color=COLOR_BORDER, size="6") -> None:
    tbl_pr = table._tbl.tblPr
    borders = tbl_pr.first_child_found_in("w:tblBorders")
    if borders is None:
        borders = OxmlElement("w:tblBorders")
        tbl_pr.append(borders)
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        tag = f"w:{edge}"
        node = borders.find(qn(tag))
        if node is None:
            node = OxmlElement(tag)
            borders.append(node)
        node.set(qn("w:val"), "single")
        node.set(qn("w:sz"), size)
        node.set(qn("w:color"), color)


def set_repeat_header_text_style(row) -> None:
    for cell in row.cells:
        set_cell_shading(cell, COLOR_NAVY)
        cell.vertical_alignment = WD_ALIGN_VERTICAL.CENTER
        for paragraph in cell.paragraphs:
            paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
            for run in paragraph.runs:
                run.font.bold = True
                run.font.color.rgb = RGBColor(255, 255, 255)
                run.font.size = Pt(9)


def set_run_font(run, east=FONT_SONG, latin="Arial", size=None, bold=None, color=None) -> None:
    run.font.name = latin
    run._element.get_or_add_rPr().rFonts.set(qn("w:eastAsia"), east)
    if size is not None:
        run.font.size = Pt(size)
    if bold is not None:
        run.font.bold = bold
    if color:
        run.font.color.rgb = RGBColor.from_string(color)


def add_page_number(paragraph) -> None:
    paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = paragraph.add_run("第 ")
    set_run_font(run, size=8, color=COLOR_MUTED)
    fld = OxmlElement("w:fldSimple")
    fld.set(qn("w:instr"), "PAGE")
    paragraph._p.append(fld)
    run = paragraph.add_run(" 页")
    set_run_font(run, size=8, color=COLOR_MUTED)


def configure_doc(doc: Document, title: str, header_text: str | None = None) -> None:
    section = doc.sections[0]
    section.page_width = Cm(21)
    section.page_height = Cm(29.7)
    section.top_margin = Cm(1.7)
    section.bottom_margin = Cm(1.65)
    section.left_margin = Cm(1.8)
    section.right_margin = Cm(1.8)

    normal = doc.styles["Normal"]
    normal.font.name = "Arial"
    normal._element.rPr.rFonts.set(qn("w:eastAsia"), FONT_SONG)
    normal.font.size = Pt(10.5)
    normal.font.color.rgb = RGBColor.from_string(COLOR_TEXT)
    normal.paragraph_format.space_after = Pt(5)
    normal.paragraph_format.line_spacing = 1.35

    for style_name, size in (("Title", 25), ("Heading 1", 16), ("Heading 2", 12.5), ("Heading 3", 11)):
        style = doc.styles[style_name]
        style.font.name = "Arial"
        style._element.rPr.rFonts.set(qn("w:eastAsia"), FONT_HEI)
        style.font.size = Pt(size)
        style.font.bold = True
        style.font.color.rgb = RGBColor(0, 0, 0)
        style.paragraph_format.space_before = Pt(10 if style_name != "Title" else 0)
        style.paragraph_format.space_after = Pt(7)
        style.paragraph_format.keep_with_next = True

    core = doc.core_properties
    core.title = title
    core.subject = "计算机软件著作权登记材料"
    core.author = OWNER
    core.keywords = f"{SHORT_NAME}, 软件著作权, Android, {VERSION}"

    if header_text:
        header = section.header
        header.is_linked_to_previous = False
        p = header.paragraphs[0]
        p.alignment = WD_ALIGN_PARAGRAPH.RIGHT
        run = p.add_run(header_text)
        set_run_font(run, size=8, color=COLOR_MUTED)
    footer = section.footer
    footer.is_linked_to_previous = False
    add_page_number(footer.paragraphs[0])


def add_title(doc: Document, title: str, subtitle: str | None = None) -> None:
    p = doc.add_paragraph(style="Title")
    p.alignment = WD_ALIGN_PARAGRAPH.LEFT
    run = p.add_run(title)
    set_run_font(run, east=FONT_HEI, size=25, bold=True, color="000000")
    if subtitle:
        p2 = doc.add_paragraph()
        p2.paragraph_format.space_after = Pt(14)
        run = p2.add_run(subtitle)
        set_run_font(run, size=11, color=COLOR_MUTED)


def add_paragraph(doc: Document, text: str, *, bold_lead: str | None = None, size=10.5, after=5, line=1.35) -> None:
    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(after)
    p.paragraph_format.line_spacing = line
    if bold_lead and text.startswith(bold_lead):
        lead = p.add_run(bold_lead)
        set_run_font(lead, east=FONT_HEI, size=size, bold=True)
        rest = p.add_run(text[len(bold_lead):])
        set_run_font(rest, size=size)
    else:
        run = p.add_run(text)
        set_run_font(run, size=size)


def add_bullets(doc: Document, items: Iterable[str], size=10, compact=False) -> None:
    for item in items:
        p = doc.add_paragraph(style="List Bullet")
        p.paragraph_format.left_indent = Cm(0.55)
        p.paragraph_format.first_line_indent = Cm(-0.2)
        p.paragraph_format.space_after = Pt(2 if compact else 4)
        p.paragraph_format.line_spacing = 1.2 if compact else 1.3
        run = p.add_run(item)
        set_run_font(run, size=size)


def add_table(doc: Document, headers: list[str], rows: list[list[str]], widths_cm: list[float]) -> None:
    table = doc.add_table(rows=1, cols=len(headers))
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = False
    set_table_borders(table)
    hdr = table.rows[0]
    set_repeat_table_header(hdr)
    for i, header in enumerate(headers):
        hdr.cells[i].width = Cm(widths_cm[i])
        hdr.cells[i].text = header
        set_cell_margins(hdr.cells[i])
    set_repeat_header_text_style(hdr)
    for ridx, values in enumerate(rows):
        row = table.add_row()
        for i, value in enumerate(values):
            cell = row.cells[i]
            cell.width = Cm(widths_cm[i])
            cell.vertical_alignment = WD_ALIGN_VERTICAL.CENTER
            cell.text = value
            set_cell_margins(cell)
            if ridx % 2:
                set_cell_shading(cell, COLOR_PALE)
            for p in cell.paragraphs:
                p.paragraph_format.space_after = Pt(0)
                p.paragraph_format.line_spacing = 1.2
                for run in p.runs:
                    set_run_font(run, size=8.8)
    doc.add_paragraph().paragraph_format.space_after = Pt(1)


def add_picture(doc: Document, path: Path, *, height_cm: float | None = None, width_cm: float | None = None, caption: str | None = None) -> None:
    if path.suffix.lower() == ".webp":
        converted_dir = WORK / "converted_images"
        converted_dir.mkdir(parents=True, exist_ok=True)
        converted = converted_dir / f"{path.stem}.png"
        if not converted.is_file() or converted.stat().st_mtime < path.stat().st_mtime:
            with Image.open(path) as source_image:
                source_image.convert("RGB").save(converted, format="PNG", optimize=True)
        path = converted
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_after = Pt(3)
    kwargs = {}
    if height_cm:
        kwargs["height"] = Cm(height_cm)
    if width_cm:
        kwargs["width"] = Cm(width_cm)
    p.add_run().add_picture(str(path), **kwargs)
    if caption:
        cp = doc.add_paragraph()
        cp.alignment = WD_ALIGN_PARAGRAPH.CENTER
        cp.paragraph_format.space_after = Pt(4)
        run = cp.add_run(caption)
        set_run_font(run, size=8.5, color=COLOR_MUTED)


def page_break(doc: Document) -> None:
    doc.add_page_break()


def build_guide(source_total_lines: int, source_nonblank: int, file_count: int, listing_sha: str) -> None:
    doc = Document()
    configure_doc(doc, "乐颜秀软件著作权登记填报与材料清单", "乐颜秀软件著作权登记材料")
    add_title(doc, "乐颜秀软件著作权登记填报与材料清单", "用于中国版权保护中心 R11 软件著作权登记申请")
    add_paragraph(
        doc,
        "本材料包已按现有 Android App 代码和界面整理，可直接用于填写软件开发信息、软件功能与特点，并上传程序和文档鉴别材料。"
        "软件名称、版本、权利人和鉴别材料页眉已经统一。提交前，公司只需完成三项事实确认：著作权归属、开发完成日期、是否曾向公众发表。",
        size=11,
        after=10,
    )

    doc.add_heading("一 结论与提交口径", level=1)
    add_table(
        doc,
        ["项目", "建议填报内容", "状态"],
        [
            ["软件全称", SOFTWARE_NAME, "可直接使用"],
            ["软件简称", SHORT_NAME, "可直接使用"],
            ["版本号", VERSION, f"与 Android {ANDROID_VERSION} 对应"],
            ["著作权人", OWNER, "须与营业执照一致"],
            ["开发方式", "独立开发", "须确认人员或委托开发权属"],
            ["权利取得方式", "原始取得", "无转让或承继时采用"],
            ["权利范围", "全部权利", "无共有或限制时采用"],
            ["发表状态", "建议选择未发表", "仅内部测试且未向公众提供时"],
        ],
        [3.2, 8.7, 4.3],
    )
    add_paragraph(
        doc,
        "重要：如果项目由外部个人或供应商实际开发，且公司没有劳动关系、委托开发合同或著作权归属条款，不应直接选择“独立开发、原始取得、全部权利”。"
        "公司应先补齐权属文件，再按真实关系填报。",
        bold_lead="重要：",
        size=10.5,
    )

    doc.add_heading("二 申请人和软件基本信息", level=1)
    add_table(
        doc,
        ["字段", "填报内容", "核验依据"],
        [
            ["申请人名称", OWNER, "营业执照"],
            ["统一社会信用代码", USCC, "营业执照"],
            ["软件全称", SOFTWARE_NAME, "App 功能与材料名称"],
            ["软件简称", SHORT_NAME, "Android 应用显示名称"],
            ["版本号", VERSION, "登记版本"],
            ["Android 包名", PACKAGE_ID, "Capacitor 和 Gradle 配置"],
            ["Android 包版本", ANDROID_VERSION, "Gradle versionName"],
            ["建议开发完成日期", COMPLETION_DATE, "现有稳定测试包及代码快照"],
        ],
        [3.3, 7.8, 5.1],
    )
    add_paragraph(
        doc,
        "软件名称建议保留“AI影像创作软件”后缀，以准确概括视频与图片两类功能。证书、申请表、源程序 PDF、说明书 PDF 中必须使用同一全称和版本号。",
    )

    doc.add_heading("三 软件开发信息字段", level=1)
    development_rows = [[name, value, str(len(value))] for name, value in SHORT_FIELDS.items() if name not in ("开发目的", "面向领域/行业")]
    add_table(doc, ["系统字段", "可直接粘贴", "字符数"], development_rows, [4.2, 9.7, 2.3])
    add_table(
        doc,
        ["系统字段", "选择或填报"],
        [
            ["编程语言", "选择 HTML；其他语言填写 TypeScript、JavaScript、Java、Python、CSS"],
            ["源程序量", f"{source_total_lines} 行"],
            ["软件类型", "应用软件"],
            ["运行形态", "Android App，客户端与云端服务协同运行"],
        ],
        [4.2, 12.0],
    )
    add_paragraph(
        doc,
        f"源程序量按本次登记快照的 {file_count} 个自研业务文件统计：共 {source_total_lines} 个物理行，其中非空行 {source_nonblank}。"
        "统计排除了 node_modules、构建产物、生成文件、第三方通用 UI 组件、测试脚本和历史归档。",
    )

    doc.add_heading("四 软件功能与特点字段", level=1)
    add_table(
        doc,
        ["系统字段", "可直接粘贴", "字符数"],
        [
            ["开发目的", SHORT_FIELDS["开发目的"], str(len(SHORT_FIELDS["开发目的"]))],
            ["面向领域/行业", SHORT_FIELDS["面向领域/行业"], str(len(SHORT_FIELDS["面向领域/行业"]))],
            ["技术特点自定义说明", TECH_FEATURES, str(len(TECH_FEATURES))],
        ],
        [3.6, 10.2, 2.4],
    )
    add_paragraph(doc, "技术特点选项：选择“APP”和“人工智能软件”。如系统允许多选，可再选择“云计算软件”；不建议选择与实际功能无关的金融、医疗、游戏或物联网类型。")
    doc.add_heading("软件的主要功能", level=2)
    add_paragraph(doc, MAIN_FUNCTIONS, size=10.2, line=1.4)
    add_paragraph(doc, f"以上正文共 {len(MAIN_FUNCTIONS)} 个字符，满足截图所示 500 至 1300 字符范围。", size=9, after=8)

    doc.add_heading("五 本材料包文件", level=1)
    add_table(
        doc,
        ["文件", "用途", "提交方式"],
        [
            [SOURCE_PDF.name, "程序鉴别材料，前后各连续 30 页", "程序鉴别材料选择一般交存后上传 PDF"],
            [f"{SOFTWARE_NAME}{VERSION}-用户操作说明书.pdf", "文档鉴别材料，30 页完整说明书", "文档鉴别材料选择一般交存后上传 PDF"],
            [MANUAL_DOCX.name, "说明书可编辑原稿", "留档，不作为系统首选上传件"],
            [INVENTORY_CSV.name, "源程序文件范围和行数复核", "内部留档，通常不上传"],
            ["材料包使用说明.txt", "提交顺序、缺件和校验值", "内部留档"],
        ],
        [6.8, 5.2, 4.2],
    )

    doc.add_heading("六 程序鉴别材料说明", level=1)
    add_bullets(
        doc,
        [
            "采用一般交存，不遮盖代码，不选择例外交存。",
            "源程序 PDF 共 60 页：第 1 至 30 页为排版后的前连续 30 页，第 31 至 60 页为后连续 30 页。",
            "每页固定显示 50 行源程序，页眉统一为软件全称、版本号和页码；页脚统一为著作权人。",
            "代码取自当前 Android App、React 客户端、Node.js 服务端和自研原生插件，未包含密钥文件、依赖包、构建产物和测试记录。",
            f"本次源程序排版快照 SHA-256：{listing_sha}。",
        ],
    )
    add_paragraph(doc, "如果提交前继续修改核心功能，建议重新生成两份鉴别材料，避免表单功能说明与代码快照不一致。仅改公司协议链接、服务器地址或商店文案通常不影响本次登记口径。")

    doc.add_heading("七 文档鉴别材料说明", level=1)
    add_bullets(
        doc,
        [
            "说明书共 30 页，属于不足 60 页的完整文档，因此上传全部页面。",
            "说明书使用项目当前真实界面和功能图片，覆盖安装、隐私选择、模板浏览、照片选择、生成、保存、分享、作品管理和异常处理。",
            "说明书标题、页眉、软件名称和版本号与源程序材料保持一致。",
            "说明书不把未开通的生产能力描述为已经上线，也不写入第三方密钥、服务器密码或用户个人信息。",
        ],
    )

    doc.add_heading("八 公司需补充或确认的证明文件", level=1)
    add_table(
        doc,
        ["事项", "为何需要", "处理方式"],
        [
            ["营业执照", "证明法人主体身份", "准备清晰彩色扫描件；名称和代码须与申请表一致"],
            ["权属确认", "决定开发方式和权利取得方式", "核对员工劳动关系、委托开发合同、项目任务书或著作权转让文件"],
            ["开发完成日期", "属于登记事实", f"确认是否采用 {COMPLETION_DATE}；不得早于本版本实际完成"],
            ["发表状态", "影响是否填写首次发表日期和地点", "若仅内部测试，选择未发表；若已公开提供下载或公开使用，按真实日期和地点填写"],
            ["经办身份", "企业账号实名认证和办理授权", "法定代表人办理或按系统要求准备经办授权材料"],
        ],
        [3.0, 5.0, 8.2],
    )
    add_paragraph(doc, "本材料包未放入营业执照、法定代表人证件、经办人证件或签章页，避免把身份资料散落在代码目录。公司应在中国版权保护中心账号内按页面要求上传。")

    doc.add_heading("九 权属与第三方组件审查", level=1)
    add_paragraph(doc, "登记保护的是软件代码和文档的表达，不延及软件采用的思想、处理过程、操作方法或数学概念。项目可以调用第三方云模型和开源组件，但申请人只能主张其有权登记的自研代码和文档。")
    add_bullets(
        doc,
        [
            "第三方依赖包括 React、Capacitor、Hono、阿里云与腾讯云 SDK 等；本次源程序材料没有交存这些依赖包的源码。",
            "通用 UI 组件目录、node_modules、Android 构建缓存和编译后的 Web 资源均已排除。",
            "如代码由外部开发者、顾问或供应商编写，应检查合同是否明确约定软件著作权归公司所有，并保留付款、交付和验收记录。",
            "如存在合作开发者或受让关系，应按真实权利关系增加共同申请人或提交合同，不应只凭公司出资推定全部权利。",
        ],
    )

    doc.add_heading("十 提交步骤", level=1)
    steps = [
        "使用企业主体账号进入 R11 软件著作权登记申请。",
        "填写软件基本信息，统一采用本文件的软件全称、简称和版本号。",
        "按第三、四节复制开发信息、主要功能和技术特点。",
        "程序鉴别材料选择一般交存，上传源程序 PDF。",
        "文档鉴别材料选择一般交存，上传用户操作说明书 PDF。",
        "按实际情况上传营业执照和权属证明文件。",
        "提交前逐项检查申请人名称、软件名称、版本号、开发方式、完成日期和发表状态。",
        "下载或截图保存最终申请表和提交回执，便于后续补正时核对。",
    ]
    for idx, step in enumerate(steps, 1):
        p = doc.add_paragraph()
        p.paragraph_format.left_indent = Cm(0.3)
        p.paragraph_format.first_line_indent = Cm(-0.3)
        p.paragraph_format.space_after = Pt(5)
        run = p.add_run(f"{idx}. {step}")
        set_run_font(run, size=10.3)

    doc.add_heading("十一 提交前对抗检查", level=1)
    add_table(
        doc,
        ["检查项", "通过标准"],
        [
            ["名称一致", f"所有材料均为“{SOFTWARE_NAME} {VERSION}”"],
            ["权利人一致", f"所有材料均为“{OWNER}”"],
            ["代码连续", "源程序每页 50 行，前后各 30 页，页序连续"],
            ["文档完整", "说明书 30 页全部上传，没有抽页或缺页"],
            ["无敏感信息", "PDF 中没有 API 密钥、账号密码、个人证件号或用户照片"],
            ["功能一致", "申请表功能、说明书功能和当前代码实现相互对应"],
            ["权属真实", "开发方式、合同和申请人关系能够形成证据链"],
        ],
        [4.0, 12.2],
    )

    doc.add_heading("十二 规则依据", level=1)
    add_paragraph(doc, "《计算机软件著作权登记办法》第九条至第十二条规定了申请表、鉴别材料、证明文件，以及一般交存和例外交存方式。")
    add_paragraph(doc, "国家版权局现行页面：https://www.ncac.gov.cn/xxfb/flfg/bmgz/202410/t20241015_869486.html", size=9.5)
    add_paragraph(doc, "《计算机软件保护条例》规定了软件、程序、文档、开发者和著作权人的基本概念，并要求受保护的软件由开发者独立开发且固定在有形载体上。")
    add_paragraph(doc, "司法部国家行政法规库：https://xzfg.moj.gov.cn/front/law/detail?LawID=913", size=9.5)
    add_paragraph(doc, "本文件用于整理申报材料和降低补正风险，不替代登记机构对具体申请的审查。", size=9.5, after=0)

    doc.save(GUIDE_DOCX)


@dataclass(frozen=True)
class SourceLine:
    global_no: int
    rel_path: str
    file_no: int
    text: str


def source_files() -> list[Path]:
    files: list[Path] = []
    files.append(ROOT / "capacitor.config.ts")
    front_order = [
        "src/main.tsx",
        "src/App.tsx",
        "src/App.css",
        "src/index.css",
        "src/components/AppErrorBoundary.tsx",
        "src/data/effects.ts",
        "src/data/templates.ts",
        "src/hooks/use-mobile.ts",
        "src/lib/api.ts",
        "src/lib/composite.ts",
        "src/lib/growth.ts",
        "src/lib/native.ts",
        "src/lib/privacy.ts",
        "src/lib/utils.ts",
        "src/views/Custom.tsx",
        "src/views/Flow.tsx",
        "src/views/Home.tsx",
        "src/views/Mine.tsx",
        "src/views/Play.tsx",
        "src/views/PrivacyGate.tsx",
        "src/views/Rank.tsx",
        "src/views/Share.tsx",
        "src/views/Songs.tsx",
        "src/views/TemplateMedia.tsx",
    ]
    files.extend(ROOT / item for item in front_order)
    server_order = [
        "server/ai-marking.js",
        "server/auth.js",
        "server/compliance-store.js",
        "server/content-safety.js",
        "server/fix-occlusion.py",
        "server/idphoto-compose.py",
        "server/mark-ai.py",
        "server/matting.js",
        "server/media-validation.js",
        "server/metrics.js",
        "server/monitoring.js",
        "server/network-policy.js",
        "server/photo-bg-compose.py",
        "server/photo-effects.js",
        "server/provider-http.js",
        "server/provider-registry.js",
        "server/remote-fetch.js",
        "server/repair.js",
        "server/retention.js",
        "server/security-log.js",
        "server/storage.js",
        "server/supplier-lifecycle.js",
        "server/tasks-store.js",
    ]
    files.extend(ROOT / item for item in server_order)
    files.extend(sorted((ROOT / "server/providers").glob("*.js"), key=lambda p: p.name.lower()))
    files.append(ROOT / "server/index.js")
    files.extend(
        [
            ROOT / "android/app/src/main/java/com/yibohuaxia/leyanxiu/DeviceIdentityPlugin.java",
            ROOT / "android/app/src/main/java/com/yibohuaxia/leyanxiu/GalleryMediaStorePlugin.java",
            ROOT / "android/app/src/main/java/com/yibohuaxia/leyanxiu/MainActivity.java",
        ]
    )
    missing = [path for path in files if not path.is_file()]
    if missing:
        raise FileNotFoundError(f"Source files missing: {missing}")
    return files


def load_source_lines(files: list[Path]) -> tuple[list[SourceLine], int]:
    lines: list[SourceLine] = []
    global_no = 0
    nonblank = 0
    with INVENTORY_CSV.open("w", newline="", encoding="utf-8-sig") as stream:
        writer = csv.writer(stream)
        writer.writerow(["序号", "相对路径", "物理行数", "非空行数", "SHA-256"])
        for idx, path in enumerate(files, 1):
            text = path.read_text(encoding="utf-8", errors="replace")
            file_lines = text.splitlines()
            file_nonblank = sum(1 for line in file_lines if line.strip())
            nonblank += file_nonblank
            rel = path.relative_to(ROOT).as_posix()
            writer.writerow([idx, rel, len(file_lines), file_nonblank, hashlib.sha256(path.read_bytes()).hexdigest().upper()])
            for file_no, line in enumerate(file_lines, 1):
                global_no += 1
                lines.append(SourceLine(global_no, rel, file_no, line.rstrip()))
        writer.writerow(["合计", f"{len(files)}个文件", global_no, nonblank, ""])
    return lines, nonblank


def visual_width(text: str) -> int:
    width = 0
    for ch in text:
        width += 2 if unicodedata.east_asian_width(ch) in ("W", "F", "A") else 1
    return width


def wrap_visual(text: str, max_width: int = 118) -> list[str]:
    expanded = text.expandtabs(4)
    if expanded == "":
        return [""]
    parts: list[str] = []
    current: list[str] = []
    width = 0
    for ch in expanded:
        ch_width = 2 if unicodedata.east_asian_width(ch) in ("W", "F", "A") else 1
        if current and width + ch_width > max_width:
            parts.append("".join(current))
            current = [ch]
            width = ch_width
        else:
            current.append(ch)
            width += ch_width
    if current:
        parts.append("".join(current))
    return parts or [""]


@dataclass(frozen=True)
class DisplayLine:
    source: SourceLine
    continuation: int
    text: str


def display_lines(source: list[SourceLine]) -> list[DisplayLine]:
    rows: list[DisplayLine] = []
    for item in source:
        for continuation, segment in enumerate(wrap_visual(item.text)):
            rows.append(DisplayLine(item, continuation, segment))
    return rows


def secret_scan(text: str) -> None:
    patterns = [
        r"sk-[A-Za-z0-9_-]{12,}",
        r"LTAI[A-Za-z0-9]{12,}",
        r"AKID[A-Za-z0-9]{12,}",
        r"(?i)secret[_-]?(?:key|id)\s*[:=]\s*['\"][^'\"]{8,}['\"]",
    ]
    for pattern in patterns:
        if re.search(pattern, text):
            raise RuntimeError(f"Potential credential detected by pattern: {pattern}")


def build_source_pdf(source: list[SourceLine]) -> str:
    all_text = "\n".join(item.text for item in source)
    secret_scan(all_text)
    listing_sha = hashlib.sha256(all_text.encode("utf-8")).hexdigest().upper()
    rows = display_lines(source)
    if len(rows) < 3000:
        raise RuntimeError(f"Not enough display lines: {len(rows)}")
    selected = rows[:1500] + rows[-1500:]
    assert len(selected) == 3000

    pdfmetrics.registerFont(TTFont("SimFang", r"C:\Windows\Fonts\simfang.ttf"))
    pdfmetrics.registerFont(TTFont("SimHei", r"C:\Windows\Fonts\simhei.ttf"))
    page_w, page_h = A4
    c = canvas.Canvas(str(SOURCE_PDF), pagesize=A4, pageCompression=1)
    c.setTitle(f"{SOFTWARE_NAME}{VERSION} 源程序鉴别材料")
    c.setAuthor(OWNER)
    c.setSubject("计算机软件著作权登记程序鉴别材料")

    for page_no in range(1, 61):
        page_rows = selected[(page_no - 1) * 50 : page_no * 50]
        section = "前30页" if page_no <= 30 else "后30页"
        c.setFont("SimHei", 10.5)
        c.drawString(36, page_h - 34, f"{SOFTWARE_NAME} {VERSION} 源程序")
        c.setFont("SimFang", 7.2)
        c.drawRightString(page_w - 36, page_h - 34, f"{section}  第{page_no}页  共60页")
        first = page_rows[0].source
        last = page_rows[-1].source
        range_text = f"{first.rel_path} 第{first.file_no}行 至 {last.rel_path} 第{last.file_no}行"
        c.setFont("SimFang", 6.8)
        c.drawString(36, page_h - 50, range_text[:130])
        c.setStrokeColorRGB(0.78, 0.81, 0.84)
        c.line(36, page_h - 57, page_w - 36, page_h - 57)

        y = page_h - 72
        c.setFont("SimFang", 6.35)
        for row in page_rows:
            suffix = "" if row.continuation == 0 else f".{row.continuation}"
            number = f"{row.source.global_no:05d}{suffix:<3}"
            c.setFillColorRGB(0.32, 0.34, 0.37)
            c.drawString(36, y, number)
            c.setFillColorRGB(0.07, 0.08, 0.09)
            c.drawString(72, y, row.text)
            y -= 13.55

        c.setStrokeColorRGB(0.82, 0.84, 0.86)
        c.line(36, 58, page_w - 36, 58)
        c.setFont("SimFang", 7.2)
        c.setFillColorRGB(0.35, 0.37, 0.40)
        c.drawString(36, 43, f"著作权人：{OWNER}")
        c.drawRightString(page_w - 36, 43, f"源程序总量：{len(source)}行")
        c.showPage()
    c.save()
    return listing_sha


def add_manual_body(doc: Document, intro: str, bullets: list[str], note: str | None = None) -> None:
    add_paragraph(doc, intro, size=10.4, line=1.32, after=5)
    add_bullets(doc, bullets, size=9.8, compact=True)
    if note:
        add_paragraph(doc, note, bold_lead="注意：" if note.startswith("注意：") else None, size=9.6, line=1.25, after=3)


def manual_page(doc: Document, number: int, title: str, intro: str, bullets: list[str], *, image: Path | None = None, caption: str | None = None, image_height=9.2, last=False) -> None:
    h = doc.add_paragraph(style="Heading 1")
    h.paragraph_format.space_before = Pt(0)
    h.paragraph_format.space_after = Pt(6)
    run = h.add_run(f"{number:02d} {title}")
    set_run_font(run, east=FONT_HEI, size=16, bold=True)
    add_manual_body(doc, intro, bullets)
    if image and image.is_file():
        add_picture(doc, image, height_cm=image_height, caption=caption)
    if not last:
        page_break(doc)


def build_manual() -> None:
    qa = ROOT / "output/visual-qa"
    images = {
        "privacy": qa / "privacy-gate-390x844.png",
        "featured": qa / "featured-390x844.png",
        "photos": qa / "photos-390x844.png",
        "create": qa / "video-create-390x844.png",
        "video": ROOT / "output/r12-video-mobile.png",
        "photo": ROOT / "output/r12-photo-mobile.png",
        "effect": ROOT / "output/r12-effect-e2e.png",
        "time": ROOT / "public/effects/time-travel.webp",
        "culture": ROOT / "public/effects/chinese-style.webp",
        "art": ROOT / "public/effects/art-styles.webp",
        "restore": ROOT / "public/effects/restore-renew.webp",
        "share": ROOT / "public/plays/overview-openai.png",
        "icon": ROOT / "output/imagegen/leyanxiu-app-icon-source.png",
    }

    doc = Document()
    configure_doc(doc, f"{SOFTWARE_NAME}{VERSION} 用户操作说明书", f"{SOFTWARE_NAME} {VERSION} 用户操作说明书")

    # Page 1
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(68)
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    if images["icon"].is_file():
        p.add_run().add_picture(str(images["icon"]), width=Cm(4.2))
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_before = Pt(20)
    run = p.add_run(SOFTWARE_NAME)
    set_run_font(run, east=FONT_HEI, size=26, bold=True)
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = p.add_run(f"{VERSION} 用户操作说明书")
    set_run_font(run, east=FONT_HEI, size=18, bold=True, color=COLOR_NAVY)
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_before = Pt(52)
    for line in (f"著作权人  {OWNER}", f"Android 包名  {PACKAGE_ID}", f"文档日期  {DOCUMENT_DATE}"):
        run = p.add_run(line + "\n")
        set_run_font(run, size=11, color=COLOR_MUTED)
    page_break(doc)

    # Page 2
    doc.add_heading("目录", level=1)
    toc_items = [
        "01 文档说明", "02 软件概述", "03 系统组成", "04 安装与启动", "05 权限说明", "06 首次隐私选择",
        "07 仅浏览模式", "08 主导航", "09 模板推荐", "10 视频玩法", "11 精选视频流", "12 视频声音与播放",
        "13 视频模板详情", "14 从相册选择照片", "15 使用相机拍照", "16 人脸影像处理确认", "17 年龄变化选择",
        "18 提交生成", "19 生成进度", "20 任务恢复", "21 作品结果", "22 保存到相册", "23 系统分享与文案",
        "24 百变图片", "25 时光穿越", "26 国风大片", "27 艺术风格", "28 修复焕新", "29 我的作品与数据控制",
        "30 异常处理与使用规范",
    ]
    table = doc.add_table(rows=0, cols=2)
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = False
    for idx in range(0, len(toc_items), 2):
        row = table.add_row()
        for col in range(2):
            cell = row.cells[col]
            cell.width = Cm(8.0)
            set_cell_margins(cell, top=80, bottom=80)
            item_idx = idx + col
            if item_idx < len(toc_items):
                cell.text = toc_items[item_idx]
            for pp in cell.paragraphs:
                pp.paragraph_format.space_after = Pt(0)
                for rr in pp.runs:
                    set_run_font(rr, size=9.4)
    add_paragraph(doc, "说明书共 30 页，作为不足 60 页的完整文档提交。章节编号与页码对应，便于登记审查和后续补正。", size=9.5, after=0)
    page_break(doc)

    pages = [
        (3, "文档说明", "本说明书描述乐颜秀 Android App 的安装、浏览、照片选择、AI 影像生成、保存、分享和数据控制流程。界面示例来自登记版本。", ["适用软件全称为乐颜秀AI影像创作软件。", "登记版本为V1.0，Android包版本为1.0.0。", "适用对象为已年满18周岁的普通用户。", "用户仅可上传本人照片或已取得明确授权的照片。", "在线生成能力需要网络连接和服务端对应能力就绪。", "不同手机系统版本的相册、相机和分享面板外观可能不同。"], None, None),
        (4, "软件概述", "乐颜秀通过模板化流程降低视频和图片创作门槛。用户先看效果，再选照片，随后确认处理信息并生成作品。", ["视频功能包括照片唱歌、照片跳舞和暖心语录。", "图片功能包括时光穿越、国风大片、艺术风格和修复焕新。", "精选页以全屏动态样片展示模板效果。", "图片功能入口使用效果预览图帮助用户判断结果方向。", "作品生成后可预览、保存、分享和删除。", "软件对生成内容展示AI标识。"], images["video"], "图4-1 视频与图片创作入口示例"),
        (5, "系统组成", "软件由 Android 客户端、业务服务端、对象存储和已配置的图像视频处理服务组成。客户端负责交互，服务端负责安全校验和任务编排。", ["Android客户端使用Capacitor封装React界面。", "服务端使用Node.js和Hono提供接口。", "原生插件负责设备身份、相册保存和系统能力调用。", "任务采用异步创建与状态查询方式执行。", "处理服务通过适配器按功能选择。", "作品与源照片按账号归属和保存策略管理。"], None, None),
        (6, "安装与启动", "用户安装APK后，从手机桌面点击“乐颜秀”图标启动。首次打开先进入隐私说明页面，不会自动读取照片。", ["确认手机系统为Android 7.0及以上。", "从公司批准的下载渠道取得安装包。", "安装时核对应用名称和发布主体。", "首次启动等待应用主界面加载完成。", "如系统阻止安装，按企业测试指引允许本次来源。", "正式商店版本应直接通过应用商店安装与更新。"], images["icon"], "图6-1 乐颜秀应用图标"),
        (7, "权限说明", "软件遵循按需申请权限原则。网络权限用于连接服务端；相机和旧版存储权限只在用户主动使用对应功能时触发。", ["互联网权限用于模板信息、上传和任务状态查询。", "相机权限仅在点击“直接拍照”后申请。", "Android 10及以上优先使用系统照片选择器和MediaStore。", "Android 7至9可能需要旧版存储读取或写入权限。", "拒绝相机权限后仍可从相册选择已有照片。", "用户可在系统设置中查看或撤回权限。"], None, None),
        (8, "首次隐私选择", "首次启动会展示个人信息处理摘要。用户勾选成年和照片授权承诺后，才能点击“同意并进入”开启在线创作。", ["阅读用户协议和隐私政策入口。", "确认已年满18周岁。", "确认只上传本人或已获授权的照片。", "同意前软件不连接服务端创建账号标识。", "不同意可选择仅浏览本地模板。", "后续制作时仍会再次展示人脸处理信息。"], images["privacy"], "图8-1 首次隐私说明页面"),
        (9, "仅浏览模式", "用户不同意联网处理时可以进入仅浏览模式。该模式用于查看本地模板和效果，不上传照片，也不读取账号作品。", ["页面顶部显示“仅浏览”状态。", "本地视频样片和图片预览仍可查看。", "点击需要在线生成的功能时重新显示隐私说明。", "我的页面不会读取账号和作品。", "用户可随时选择阅读并开启创作。", "退出应用不会自动改变用户的隐私选择。"], None, None),
        (10, "主导航", "主界面底部设置五个固定入口：推荐、视频玩法、精选、百变图片和我的。当前入口使用高亮颜色标识。", ["推荐用于按栏目查看视频模板。", "视频玩法用于按唱歌、跳舞和语录筛选。", "精选用于全屏逐个播放模板样片。", "百变图片用于进入四类图片效果。", "我的用于查看作品、设置和数据控制。", "在制作流程中底部导航暂时隐藏，避免误操作。"], images["featured"], "图10-1 精选页与底部主导航"),
        (11, "模板推荐", "推荐页按照编辑推荐、经典精选和最近上新组织视频模板，模板顺序来自实际配置，不展示虚构使用人数。", ["点击顶部分类切换模板列表。", "模板卡片显示封面、名称和功能说明。", "最近上新按模板发布时间倒序排列。", "点击卡片进入模板动态详情。", "暂未配置的栏目显示空状态。", "返回后保留主导航入口。"], None, None),
        (12, "视频玩法", "视频玩法页把模板分为唱歌、跳舞和语录三类。横幅和卡片提前展示效果，用户可以快速理解模板用途。", ["唱歌类让人物照片与歌曲模板配合。", "跳舞类让照片中的人物生成自然舞步。", "语录类让人物自然开口表达一段文字。", "模板卡片显示时长、封面和分类。", "点击卡片先进入详情，不会立即上传照片。", "不可用模板保持关闭状态并说明原因。"], images["video"], "图12-1 视频玩法分类页面"),
        (13, "精选视频流", "精选页打开后显示单个全屏视频模板。用户每次上滑或下滑只切换一个模板，降低一次滑过多个视频的情况。", ["当前模板自动进入可见播放区域。", "向上滑动切换到下一个模板。", "向下滑动切换到上一个模板。", "切换期间有短暂过渡动画。", "页面显示模板名称、类别和制作按钮。", "精选模板按发布时间倒序排列，新模板优先。"], images["featured"], "图13-1 单屏精选视频模板"),
        (14, "视频声音与播放", "系统会尝试自动播放当前精选样片。受Android和WebView自动播放策略影响，首次有声播放可能需要用户触摸页面。", ["页面右上角显示声音开关。", "点击声音图标可打开或关闭当前样片声音。", "模板离开可见区域后暂停播放。", "应用进入后台时暂停所有视频。", "重新回到前台后由当前页面决定是否继续播放。", "没有声音时先检查媒体音量和静音状态。"], images["featured"], "图14-1 精选页声音控制位置"),
        (15, "视频模板详情", "点击视频模板后进入详情页，页面顶部直接播放模板样片并显示声音控制，不再出现只有照片选择区的大块空白。", ["顶部先查看完整或循环样片。", "样片区域显示AI模板演示标识。", "点击声音按钮切换有声或静音。", "阅读模板名称、用途和预计处理时间。", "确认效果后点击“用我的照片制作”。", "返回按钮回到原来的模板入口。"], images["create"], "图15-1 视频模板详情与照片入口"),
        (16, "从相册选择照片", "进入制作页后，点击“从相册选择”打开系统照片选择器。软件只读取用户本次主动选择的文件。", ["优先选择清晰、正面、无遮挡的人像照片。", "确保照片中的人物已经授权制作。", "选择后页面显示照片预览。", "点击预览区可以更换照片。", "系统会检查文件格式和大小。", "读取失败时可换一张照片重试。"], images["create"], "图16-1 从相册选择照片入口"),
        (17, "使用相机拍照", "点击“直接拍照”调用系统相机。用户完成拍摄并确认后，照片返回制作页面等待进一步确认。", ["首次使用时系统可能请求相机权限。", "把人脸放在画面中央并保持光线均匀。", "避免口罩、墨镜、手部或头发遮挡主要五官。", "拍摄完成后在系统相机页面确认使用。", "不满意可以返回重新拍摄。", "拒绝相机权限后仍可改用相册。"], images["create"], "图17-1 直接拍照入口"),
        (18, "人脸影像处理确认", "照片选择完成后，页面展示本次处理用途、处理服务商、备案信息和保存期限。用户单独确认后才提交照片。", ["核对所选模板名称和输出类型。", "查看源照片保存期限说明。", "查看实际处理服务商和模型信息。", "勾选人脸影像处理授权。", "不同意不会上传照片。", "用户可在“我的”页面撤回授权或发起数据删除。"], None, None),
        (19, "年龄变化选择", "年龄变化整合为一个功能入口。用户选择目标年龄后再提交，避免把三十岁、四十岁、五十岁拆成重复功能。", ["进入“百变图片”并选择“时光穿越”。", "点击“年龄变化”。", "从目标年龄选项中选择希望查看的阶段。", "选择或拍摄一张清晰人像照片。", "确认人脸影像处理信息。", "生成结果仅用于创意展示，不用于身份或医学判断。"], images["photos"], "图19-1 时光穿越与年龄变化入口"),
        (20, "提交生成", "照片、模板和授权信息齐备后，底部“开始制作”按钮变为可用。点击后客户端上传照片并创建唯一任务。", ["提交前再次确认照片预览正确。", "保证网络连接稳定。", "点击一次开始制作，避免重复操作。", "服务端校验任务归属、文件类型和处理能力状态。", "能力未就绪时软件直接提示，不伪造成功结果。", "创建成功后自动进入进度页面。"], None, None),
        (21, "生成进度", "生成页面按任务阶段显示提示，例如检查照片、处理人像、合成画面和完成收尾。视频任务通常比图片任务耗时更长。", ["保持应用在前台可实时查看进度。", "系统按固定间隔查询任务状态。", "处理成功后自动进入结果页。", "处理失败会显示明确错误并允许返回重试。", "免费次数只按实际创建规则处理。", "不要在生成过程中反复返回并重新提交。"], images["effect"], "图21-1 图片效果生成与结果示例"),
        (22, "任务恢复", "软件记录当前未完成任务。应用被切到后台、异常关闭或网络短时中断后，再次打开会尝试恢复任务状态。", ["恢复期间页面显示正在恢复提示。", "同一任务不会因为恢复而重复创建。", "任务成功后直接进入对应结果。", "模板下线时提示到我的作品查看。", "长时间无结果时可检查网络后重试。", "已失败任务不会伪装为本地成功。"], None, None),
        (23, "作品结果", "生成完成后，结果页显示图片或视频作品，并展示“作品已完成”状态。作品中保留AI生成标识。", ["图片结果按完整比例显示。", "视频结果提供播放控制。", "核对人物、背景和画面是否符合预期。", "结果自动进入当前账号的个人影集。", "失败或明显异常时返回模板重新制作。", "不得移除作品中的AI生成标识。"], images["effect"], "图23-1 生成作品结果示例"),
        (24, "保存到相册", "Android App 中点击“保存到相册”，原生插件通过系统媒体库保存图片或视频，并返回保存结果。", ["确认手机有足够的可用空间。", "点击结果页的“保存到相册”。", "等待保存中状态结束。", "出现成功提示后打开系统相册检查。", "Android 10及以上通常不需要广泛存储权限。", "链接失效或网络中断时按提示重新获取作品。"], None, None),
        (25, "系统分享与文案", "结果页可调用Android系统分享面板，并可为作品生成一段自然的朋友圈或短视频发布文案。", ["点击分享入口打开分享面板。", "系统只展示设备上已安装且支持的应用。", "选择目标应用后由该应用完成发布。", "软件不会承诺直接跳过第三方平台的发布流程。", "需要文案时填写作品类型、语气和内容。", "复制文案后在目标平台自行确认并发布。"], images["share"], "图25-1 AI分享文案入口配图"),
        (26, "百变图片", "百变图片首页用真实效果配图展示四个大类，并在下方显示该分类的具体功能卡片。用户点击卡片后进入统一制作流程。", ["顶部横向浏览时光穿越、国风大片、艺术风格和修复焕新。", "卡片展示功能名称、说明和预期画面。", "尚未开放的卡片明确标注暂未开放。", "点击已开放功能选择照片。", "图片任务同样要求单独确认人脸处理信息。", "结果可保存、分享和加入个人影集。"], images["photos"], "图26-1 百变图片分类和效果预览"),
        (27, "时光穿越", "时光穿越用于生成年龄阶段、年代影像和经典黑白等创意效果，强调人物身份特征的连续性。", ["年龄变化支持在一个入口选择目标年龄。", "九十年代港风呈现胶片和电影光影。", "八十年代留影模拟旧时照相馆色彩。", "经典黑白照保留简洁光影和人物神态。", "选择清晰单人照片可获得更稳定结果。", "所有年龄效果仅作娱乐与创意展示。"], images["time"], "图27-1 时光穿越分类封面", 7.6),
        (28, "国风大片", "国风大片提供宋韵、敦煌、新中式和海派旗袍等东方审美方向。系统依据功能预设控制服饰、背景和色彩。", ["宋韵雅集采用清雅服饰和山水庭院。", "敦煌飞天突出壁画色彩和轻盈飘带。", "新中式肖像结合现代剪裁与东方气质。", "海派旗袍呈现温润端庄的复古写真。", "上传照片应避免复杂遮挡和多人重叠。", "生成内容不得用于冒充真实历史影像。"], images["culture"], "图28-1 国风大片分类封面", 7.6),
        (29, "艺术风格与修复焕新", "艺术风格改变画面表现方式，修复焕新改善旧照片质量。两类功能目的不同，用户应根据原照片状况选择。", ["艺术风格包括自然AI头像、现代漫画、水彩、油画和素描。", "修复功能包括人脸清晰、黑白上色、高清放大和划痕修复。", "风格化会改变画面笔触与色彩，不等同于真实照片修复。", "修复功能优先保留人物原貌，避免过度美化。", "严重破损或低分辨率照片的结果可能受限。", "重要原件应先备份，生成结果与原图分开保存。"], images["restore"], "图29-1 修复焕新分类封面", 7.3),
        (30, "我的作品与异常处理", "我的页面集中提供作品查看、删除、反馈、授权撤回、账号注销和合规信息。遇到异常时先依据页面提示处理。", ["作品列表按当前账号读取，点击作品可播放或查看。", "点击删除按钮并确认后移除对应作品。", "在问题反馈中填写相关模板、作品和具体问题。", "撤回授权后不再使用相应处理授权。", "账号注销会进入账号、作品和会话数据删除流程。", "网络不可用时暂停在线生成；权限被拒绝时改用其他输入方式；任务失败时返回原模板重试；持续问题通过公司公布的客服渠道处理。"], None, None),
    ]

    for number, title, intro, bullets, image, caption, *extra in pages:
        image_height = extra[0] if extra else 8.8
        manual_page(doc, number, title, intro, bullets, image=image, caption=caption, image_height=image_height, last=number == 30)

    doc.save(MANUAL_DOCX)


def extract_manual_pages() -> list[list[dict]]:
    doc = Document(MANUAL_DOCX)
    pages: list[list[dict]] = [[]]
    body = doc.element.body
    for child in body.iterchildren():
        if child.tag == qn("w:p"):
            text = "".join(node.text or "" for node in child.findall(".//" + qn("w:t")))
            p_style = child.find("./" + qn("w:pPr") + "/" + qn("w:pStyle"))
            style = p_style.get(qn("w:val")) if p_style is not None else "Normal"
            image_ids = [node.get(qn("r:embed")) for node in child.findall(".//" + qn("a:blip"))]
            image_blobs = []
            for rel_id in image_ids:
                if rel_id and rel_id in doc.part.related_parts:
                    image_blobs.append(doc.part.related_parts[rel_id].blob)
            if text.strip():
                pages[-1].append({"type": "text", "text": text.strip(), "style": style})
            for blob in image_blobs:
                pages[-1].append({"type": "image", "blob": blob})
            has_page_break = any(node.get(qn("w:type")) == "page" for node in child.findall(".//" + qn("w:br")))
            if has_page_break:
                pages.append([])
        elif child.tag == qn("w:tbl"):
            rows = []
            for tr in child.findall("./" + qn("w:tr")):
                values = []
                for tc in tr.findall("./" + qn("w:tc")):
                    values.append("".join(node.text or "" for node in tc.findall(".//" + qn("w:t"))).strip())
                if values:
                    rows.append(values)
            if rows:
                pages[-1].append({"type": "table", "rows": rows})
    while pages and not pages[-1]:
        pages.pop()
    return pages


def build_manual_pdf() -> None:
    pdfmetrics.registerFont(TTFont("SimFang", r"C:\Windows\Fonts\simfang.ttf"))
    pdfmetrics.registerFont(TTFont("SimHei", r"C:\Windows\Fonts\simhei.ttf"))
    pages = extract_manual_pages()
    if len(pages) != 30:
        raise RuntimeError(f"Manual must have 30 logical pages, got {len(pages)}")

    c = canvas.Canvas(str(MANUAL_PDF), pagesize=A4, pageCompression=1)
    c.setTitle(f"{SOFTWARE_NAME}{VERSION} 用户操作说明书")
    c.setAuthor(OWNER)
    c.setSubject("计算机软件著作权登记文档鉴别材料")
    page_w, page_h = A4
    left = 46
    right = page_w - 46
    bottom = 55
    avail_w = right - left

    styles = {
        "title": ParagraphStyle("PdfTitle", fontName="SimHei", fontSize=22, leading=30, alignment=TA_CENTER, textColor=colors.black, wordWrap="CJK"),
        "subtitle": ParagraphStyle("PdfSubtitle", fontName="SimHei", fontSize=16, leading=23, alignment=TA_CENTER, textColor=colors.HexColor("#24364B"), wordWrap="CJK"),
        "heading": ParagraphStyle("PdfHeading", fontName="SimHei", fontSize=16, leading=22, alignment=TA_LEFT, textColor=colors.black, wordWrap="CJK"),
        "body": ParagraphStyle("PdfBody", fontName="SimFang", fontSize=9.7, leading=14.3, alignment=TA_LEFT, textColor=colors.HexColor("#202124"), wordWrap="CJK"),
        "bullet": ParagraphStyle("PdfBullet", fontName="SimFang", fontSize=9.2, leading=13.4, leftIndent=13, firstLineIndent=-11, alignment=TA_LEFT, textColor=colors.HexColor("#202124"), wordWrap="CJK"),
        "caption": ParagraphStyle("PdfCaption", fontName="SimFang", fontSize=8.2, leading=11.5, alignment=TA_CENTER, textColor=colors.HexColor("#5F6368"), wordWrap="CJK"),
        "cover": ParagraphStyle("PdfCover", fontName="SimFang", fontSize=10.5, leading=19, alignment=TA_CENTER, textColor=colors.HexColor("#5F6368"), wordWrap="CJK"),
    }

    def draw_flowable(flowable, y, gap=5, center=False):
        width, height = flowable.wrap(avail_w, max(1, y - bottom))
        if height > y - bottom + 0.1:
            raise RuntimeError(f"Manual page overflow: need {height:.1f}, available {y-bottom:.1f}")
        x = left + (avail_w - width) / 2 if center else left
        flowable.drawOn(c, x, y - height)
        return y - height - gap

    for page_no, items in enumerate(pages, 1):
        if page_no > 1:
            c.setFont("SimFang", 7.6)
            c.setFillColorRGB(0.36, 0.38, 0.41)
            c.drawString(left, page_h - 28, f"{SOFTWARE_NAME} {VERSION} 用户操作说明书")
            c.drawRightString(right, page_h - 28, f"第{page_no}页 共30页")
            c.setStrokeColorRGB(0.82, 0.84, 0.86)
            c.line(left, page_h - 35, right, page_h - 35)
            y = page_h - 57
        else:
            y = page_h - 90

        for item in items:
            if item["type"] == "text":
                text_value = escape(item["text"]).replace("\n", "<br/>")
                style_id = item["style"]
                if page_no == 1:
                    if item["text"] == SOFTWARE_NAME:
                        style = styles["title"]
                        y -= 8
                    elif VERSION in item["text"] and "说明书" in item["text"]:
                        style = styles["subtitle"]
                    else:
                        style = styles["cover"]
                elif style_id in ("Heading1", "Title"):
                    style = styles["heading"]
                elif style_id == "ListBullet":
                    style = styles["bullet"]
                    text_value = "- " + text_value
                elif item["text"].startswith("图") and "-" in item["text"]:
                    style = styles["caption"]
                else:
                    style = styles["body"]
                y = draw_flowable(RLParagraph(text_value, style), y, gap=5)
            elif item["type"] == "image":
                stream = BytesIO(item["blob"])
                with Image.open(stream) as img:
                    px_w, px_h = img.size
                stream.seek(0)
                ratio = px_h / px_w
                if page_no == 1:
                    target_w = 4.1 * cm
                    target_h = target_w * ratio
                elif ratio > 1.35:
                    target_h = 8.6 * cm
                    target_w = target_h / ratio
                else:
                    target_w = min(12.3 * cm, avail_w)
                    target_h = target_w * ratio
                    if target_h > 7.4 * cm:
                        target_h = 7.4 * cm
                        target_w = target_h / ratio
                y = draw_flowable(RLImage(stream, width=target_w, height=target_h), y, gap=4, center=True)
            elif item["type"] == "table":
                data = [[RLParagraph(escape(value), styles["body"]) for value in row] for row in item["rows"]]
                table = RLTable(data, colWidths=[avail_w / 2, avail_w / 2])
                table.setStyle(TableStyle([
                    ("FONTNAME", (0, 0), (-1, -1), "SimFang"),
                    ("FONTSIZE", (0, 0), (-1, -1), 8.6),
                    ("TEXTCOLOR", (0, 0), (-1, -1), colors.HexColor("#202124")),
                    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                    ("LEFTPADDING", (0, 0), (-1, -1), 7),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 7),
                    ("TOPPADDING", (0, 0), (-1, -1), 5),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
                    ("LINEBELOW", (0, 0), (-1, -1), 0.35, colors.HexColor("#D9D9D9")),
                    ("BACKGROUND", (0, 0), (-1, -1), colors.white),
                ]))
                y = draw_flowable(table, y, gap=5)

        c.setStrokeColorRGB(0.84, 0.86, 0.88)
        c.line(left, 42, right, 42)
        c.setFont("SimFang", 7.5)
        c.setFillColorRGB(0.36, 0.38, 0.41)
        c.drawString(left, 28, OWNER)
        c.drawRightString(right, 28, f"第{page_no}页")
        c.showPage()
    c.save()


def write_fill_text(source_total: int, source_nonblank: int) -> None:
    content = f"""R11软件著作权登记填报内容 直接粘贴版

一 软件基本信息
软件全称：{SOFTWARE_NAME}
软件简称：{SHORT_NAME}
版本号：{VERSION}
软件分类：应用软件
开发方式：独立开发（须先确认权属）
权利取得方式：原始取得（无转让或承继时）
权利范围：全部权利（无共有或限制时）
开发完成日期：建议{COMPLETION_DATE}（公司确认后填写）
发表状态：建议未发表（仅内部测试且未向公众提供时）

二 软件开发信息
开发的硬件环境：{SHORT_FIELDS['开发的硬件环境']}
运行的硬件环境：{SHORT_FIELDS['运行的硬件环境']}
开发该软件的操作系统：{SHORT_FIELDS['开发该软件的操作系统']}
软件开发环境/开发工具：{SHORT_FIELDS['软件开发环境/开发工具']}
该软件的运行平台/操作系统：{SHORT_FIELDS['该软件的运行平台/操作系统']}
软件运行支持环境/支持软件：{SHORT_FIELDS['软件运行支持环境/支持软件']}
编程语言：选择HTML；其他语言填写TypeScript、JavaScript、Java、Python、CSS
源程序量：{source_total}

三 软件功能与特点
开发目的：{SHORT_FIELDS['开发目的']}
面向领域/行业：{SHORT_FIELDS['面向领域/行业']}
技术特点选项：APP、人工智能软件；如允许多选可增加云计算软件
技术特点自定义说明：{TECH_FEATURES}

软件的主要功能：
{MAIN_FUNCTIONS}

四 鉴别材料选择
程序鉴别材料：一般交存，上传《{SOURCE_PDF.name}》
文档鉴别材料：一般交存，上传《{MANUAL_PDF.name}》

五 申请人
申请人名称：{OWNER}
统一社会信用代码：{USCC}

六 公司提交前必须确认
1. 公司是否通过劳动关系、委托合同、项目任务书或转让文件完整取得本软件著作权。
2. {COMPLETION_DATE}是否为本登记版本真实开发完成日期。
3. 是否仅为内部测试且从未向不特定公众提供下载或使用。
4. 如已经发表，按真实首次发表日期和地点填写，不使用“未发表”。

代码统计口径：{source_total}个物理行，{source_nonblank}个非空行；不含第三方依赖、构建产物、测试脚本和历史归档。
"""
    FILL_TXT.write_text(content, encoding="utf-8-sig")


def write_package_note(source_total: int, source_nonblank: int, listing_sha: str) -> None:
    text = f"""乐颜秀软件著作权登记材料包

软件全称：{SOFTWARE_NAME}
软件简称：{SHORT_NAME}
登记版本：{VERSION}
Android包版本：{ANDROID_VERSION}
Android包名：{PACKAGE_ID}
著作权人：{OWNER}
统一社会信用代码：{USCC}

建议提交：
1. {SOURCE_PDF.name}
2. {SOFTWARE_NAME}{VERSION}-用户操作说明书.pdf
3. 企业营业执照彩色扫描件，以及登记系统按办理身份要求提示的主体身份证明
4. 在线填报完成后由系统生成的软件著作权登记申请表，按页面提示签章或确认
5. 如存在委托、合作、转让、继受取得或职务开发权属争议，补充真实合同、任务书或权属证明

公司提交前确认：
1. 著作权是否完整归属于申请公司
2. 开发完成日期是否采用{COMPLETION_DATE}
3. 是否仅内部测试且从未向不特定公众提供；如已经公开，必须填写真实首次发表日期与地点
4. 软件全称、简称、版本号、申请人名称和统一社会信用代码是否与申请表完全一致

官网上传对应关系：
程序鉴别材料 -> {SOURCE_PDF.name}
文档鉴别材料 -> {MANUAL_PDF.name}
其他相关证明文件 -> 营业执照及确有需要的权属证明

技术统计：
源程序物理行数：{source_total}
源程序非空行数：{source_nonblank}
源程序排版快照SHA-256：{listing_sha}

说明：源程序材料已排成60页，每页50个代码显示行；操作说明书为30页图文材料。APK不是R11当前页面所示必传鉴别材料，
本包未重复放入APK。请保留现有测试包及其哈希作为版本形成证据。本包中的开发完成日期和未发表状态均为填报建议，必须由公司依据真实事实确认。
"""
    PACKAGE_NOTE.write_text(text, encoding="utf-8-sig")


def write_hashes() -> None:
    files = [SOURCE_PDF, MANUAL_PDF, FILL_TXT, INVENTORY_CSV, PACKAGE_NOTE]
    lines = ["SHA-256  文件名"]
    for path in files:
        digest = hashlib.sha256(path.read_bytes()).hexdigest().upper()
        lines.append(f"{digest}  {path.name}")
    HASHES_TXT.write_text("\n".join(lines) + "\n", encoding="utf-8-sig")


def main() -> None:
    files = source_files()
    source, nonblank = load_source_lines(files)
    listing_sha = build_source_pdf(source)
    build_guide(len(source), nonblank, len(files), listing_sha)
    build_manual()
    build_manual_pdf()
    write_fill_text(len(source), nonblank)
    write_package_note(len(source), nonblank, listing_sha)
    write_hashes()
    print(f"guide={GUIDE_DOCX}")
    print(f"manual={MANUAL_DOCX}")
    print(f"source_pdf={SOURCE_PDF}")
    print(f"manual_pdf={MANUAL_PDF}")
    print(f"files={len(files)} total_lines={len(source)} nonblank={nonblank}")
    print(f"listing_sha256={listing_sha}")


if __name__ == "__main__":
    main()
