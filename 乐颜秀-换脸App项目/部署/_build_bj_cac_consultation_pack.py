from __future__ import annotations

from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    KeepTogether,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)


ROOT = Path(__file__).resolve().parent
OUT = ROOT / "北京市网信办咨询邮件材料-2026-09-14"
OUT.mkdir(parents=True, exist_ok=True)

FONT_REGULAR = r"C:\Windows\Fonts\msyh.ttc"
FONT_BOLD = r"C:\Windows\Fonts\msyhbd.ttc"
pdfmetrics.registerFont(TTFont("CN", FONT_REGULAR))
pdfmetrics.registerFont(TTFont("CN-Bold", FONT_BOLD))

NAVY = colors.HexColor("#10253F")
BLUE = colors.HexColor("#1769E0")
CYAN = colors.HexColor("#18A0AE")
INK = colors.HexColor("#172033")
MUTED = colors.HexColor("#5F6B7A")
LINE = colors.HexColor("#D9E2EC")
PALE = colors.HexColor("#F3F7FB")
PALE_BLUE = colors.HexColor("#EAF2FF")
PALE_CYAN = colors.HexColor("#E9F7F7")
WHITE = colors.white


def esc(text: str) -> str:
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace("\n", "<br/>")
    )


styles = getSampleStyleSheet()
styles.add(
    ParagraphStyle(
        name="CNTitle",
        fontName="CN-Bold",
        fontSize=20,
        leading=26,
        textColor=NAVY,
        spaceAfter=4 * mm,
    )
)
styles.add(
    ParagraphStyle(
        name="CNSubtitle",
        fontName="CN",
        fontSize=9,
        leading=14,
        textColor=MUTED,
        spaceAfter=5 * mm,
    )
)
styles.add(
    ParagraphStyle(
        name="CNH2",
        fontName="CN-Bold",
        fontSize=11.5,
        leading=16,
        textColor=NAVY,
        spaceBefore=2.5 * mm,
        spaceAfter=2 * mm,
    )
)
styles.add(
    ParagraphStyle(
        name="CNBody",
        fontName="CN",
        fontSize=9,
        leading=14,
        textColor=INK,
    )
)
styles.add(
    ParagraphStyle(
        name="CNSmall",
        fontName="CN",
        fontSize=7.2,
        leading=10.5,
        textColor=MUTED,
    )
)
styles.add(
    ParagraphStyle(
        name="CNTable",
        fontName="CN",
        fontSize=7.5,
        leading=10.5,
        textColor=INK,
    )
)
styles.add(
    ParagraphStyle(
        name="CNTableHead",
        fontName="CN-Bold",
        fontSize=7.5,
        leading=10.5,
        textColor=WHITE,
        alignment=TA_LEFT,
    )
)
styles.add(
    ParagraphStyle(
        name="CNBadge",
        fontName="CN-Bold",
        fontSize=8.5,
        leading=12,
        textColor=BLUE,
        alignment=TA_CENTER,
    )
)


def p(text: str, style: str = "CNBody") -> Paragraph:
    return Paragraph(esc(text), styles[style])


def rich(text: str, style: str = "CNBody") -> Paragraph:
    return Paragraph(text, styles[style])


def add_page_chrome(canvas, doc, label: str) -> None:
    width, height = doc.pagesize
    canvas.saveState()
    canvas.setFillColor(NAVY)
    canvas.rect(0, height - 10 * mm, width, 10 * mm, fill=1, stroke=0)
    canvas.setFont("CN-Bold", 8)
    canvas.setFillColor(WHITE)
    canvas.drawString(doc.leftMargin, height - 6.5 * mm, "乐颜秀  ·  北京市网信办咨询附件")
    canvas.setFont("CN", 7.5)
    canvas.drawRightString(width - doc.rightMargin, height - 6.5 * mm, label)
    canvas.setStrokeColor(LINE)
    canvas.line(doc.leftMargin, 12 * mm, width - doc.rightMargin, 12 * mm)
    canvas.setFont("CN", 7)
    canvas.setFillColor(MUTED)
    canvas.drawString(doc.leftMargin, 7.5 * mm, "材料日期：2026年9月14日  |  仅用于行政咨询，不代替主管部门正式认定")
    canvas.drawRightString(width - doc.rightMargin, 7.5 * mm, f"第 {doc.page} 页")
    canvas.restoreState()


def make_doc(path: Path, pagesize=A4, label="咨询附件") -> BaseDocTemplate:
    width, height = pagesize
    doc = BaseDocTemplate(
        str(path),
        pagesize=pagesize,
        leftMargin=15 * mm,
        rightMargin=15 * mm,
        topMargin=18 * mm,
        bottomMargin=16 * mm,
        title=path.stem,
        author="REDACTED_COMPANY_NAME",
        subject="乐颜秀生成式人工智能服务合规咨询材料",
    )
    frame = Frame(
        doc.leftMargin,
        doc.bottomMargin,
        width - doc.leftMargin - doc.rightMargin,
        height - doc.topMargin - doc.bottomMargin,
        id="content",
        leftPadding=0,
        rightPadding=0,
        topPadding=0,
        bottomPadding=0,
    )
    doc.addPageTemplates(
        [PageTemplate(id="main", frames=[frame], onPage=lambda c, d: add_page_chrome(c, d, label))]
    )
    return doc


def key_value_table(rows, widths):
    data = []
    for key, value in rows:
        data.append([rich(f"<b>{esc(key)}</b>", "CNTable"), p(value, "CNTable")])
    table = Table(data, colWidths=widths, hAlign="LEFT")
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (0, -1), PALE_BLUE),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("BOX", (0, 0), (-1, -1), 0.5, LINE),
                ("INNERGRID", (0, 0), (-1, -1), 0.35, LINE),
                ("LEFTPADDING", (0, 0), (-1, -1), 7),
                ("RIGHTPADDING", (0, 0), (-1, -1), 7),
                ("TOPPADDING", (0, 0), (-1, -1), 5),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ]
        )
    )
    return table


def bullet_list(items, style="CNBody"):
    return [rich(f"<font color='#1769E0'>●</font>  {esc(item)}", style) for item in items]


def build_product_pdf() -> Path:
    path = OUT / "附件1-乐颜秀产品说明.pdf"
    doc = make_doc(path, A4, "附件 1 / 产品说明")
    story = [
        p("乐颜秀产品说明", "CNTitle"),
        p("供北京市互联网信息办公室判断生成式人工智能应用登记、深度合成算法备案及相关合规路径", "CNSubtitle"),
        p("一、基本信息", "CNH2"),
        key_value_table(
            [
                ("运营主体", "REDACTED_COMPANY_NAME（统一社会信用代码：REDACTED_COMPANY_REGISTRATION）"),
                ("产品形态", "微信小程序与 Android App（包名：com.yibohuaxia.leyanxiu），计划共用同一套服务端和 AI 能力"),
                ("当前阶段", "拟上线，处于封闭测试与合规准备阶段；尚未面向不特定公众正式开放"),
                ("服务对象", "境内个人用户；用户上传本人或已获授权的人像素材，选择模板或效果生成个人作品"),
            ],
            [31 * mm, 149 * mm],
        ),
        p("二、拟提供的 AI 能力", "CNH2"),
        Table(
            [
                [p("视觉生成与编辑", "CNBadge"), p("视频模板人脸融合、图片人脸融合、年龄变化、老照片修复与上色、AI 头像和艺术风格、照片动态化/跳舞及图生视频。部分能力仍处于供应商选型和质量验收阶段。", "CNTable")],
                [p("文本生成", "CNBadge"), p("根据用户填写的作品类型、语气和描述生成分享文案。该能力不接收原始人像素材。", "CNTable")],
                [p("不提供", "CNBadge"), p("不自研、不训练、不微调、不私有部署基础模型；不向用户提供模型参数、模型训练或开放式模型调用能力。", "CNTable")],
            ],
            colWidths=[31 * mm, 149 * mm],
            style=TableStyle(
                [
                    ("BACKGROUND", (0, 0), (0, -1), PALE_CYAN),
                    ("BOX", (0, 0), (-1, -1), 0.5, LINE),
                    ("INNERGRID", (0, 0), (-1, -1), 0.35, LINE),
                    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                    ("LEFTPADDING", (0, 0), (-1, -1), 7),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 7),
                    ("TOPPADDING", (0, 0), (-1, -1), 6),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
                ]
            ),
        ),
        p("三、典型用户流程", "CNH2"),
        Table(
            [[p("1", "CNBadge"), p("用户阅读隐私与 AI 服务提示并授权", "CNTable"), p("2", "CNBadge"), p("上传本人或已获授权照片，选择模板/效果", "CNTable"), p("3", "CNBadge"), p("服务端调用境内第三方云厂商 API", "CNTable")],
             [p("4", "CNBadge"), p("接收生成结果并进行内容安全处理", "CNTable"), p("5", "CNBadge"), p("按规定添加显著及隐式标识", "CNTable"), p("6", "CNBadge"), p("结果进入用户个人作品，用户可保存、分享或删除", "CNTable")]],
            colWidths=[9 * mm, 51 * mm, 9 * mm, 51 * mm, 9 * mm, 51 * mm],
            style=TableStyle(
                [
                    ("BACKGROUND", (0, 0), (-1, -1), PALE),
                    ("BOX", (0, 0), (-1, -1), 0.5, LINE),
                    ("INNERGRID", (0, 0), (-1, -1), 0.35, LINE),
                    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                    ("LEFTPADDING", (0, 0), (-1, -1), 5),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 5),
                    ("TOPPADDING", (0, 0), (-1, -1), 6),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
                ]
            ),
        ),
        p("四、内容传播边界", "CNH2"),
        *bullet_list(
            [
                "产品不设用户公开发布、公开主页、关注、粉丝、评论或用户内容推荐社区；模板展示页为运营方自有内容。",
                "生成作品默认仅在用户个人账户内可见，不进入公共内容流；用户可主动保存到本地或调用系统分享能力发送至外部平台。",
                "产品不提供新闻信息服务，不组织公共话题讨论，不以生成内容建立公众传播社区。",
            ],
            "CNTable",
        ),
        p("五、上线前拟落实的控制", "CNH2"),
        rich(
            "<b>授权与告知</b>：人脸信息单独同意、第三方处理告知、未成年人保护；　"
            "<b>内容治理</b>：输入输出审核、投诉举报、敏感场景限制；　"
            "<b>数据安全</b>：最小保存、私有存储、可删除、日志脱敏；　"
            "<b>AI 标识</b>：依据适用规定对生成/合成内容添加显著和隐式标识。",
            "CNTable",
        ),
    ]
    doc.build(story)
    return path


def build_capability_pdf() -> Path:
    path = OUT / "附件2-乐颜秀AI能力与第三方服务清单.pdf"
    doc = make_doc(path, landscape(A4), "附件 2 / AI 能力清单")
    story = [
        p("乐颜秀 AI 能力与第三方服务清单", "CNTitle"),
        p("说明：下表反映当前代码接入及拟上线范围。供应商、模型版本和备案编号将在正式上线前以合同、生产配置及供应商书面材料最终核定。", "CNSubtitle"),
    ]
    headers = ["功能", "输入 / 输出", "技术类型", "当前接入或拟选服务", "上线状态", "备案信息状态"]
    rows = [
        ["视频模板人脸融合", "本人/获授权照片 + 运营方模板视频 → 合成视频", "人脸替换、视频合成", "阿里云视觉智能开放平台：MergeVideoModelFace / MergeVideoFace", "已联调，待合规验收", "服务商、算法及模型备案信息待书面核验"],
        ["图片人脸融合", "本人/获授权照片 + 运营方模板图 → 合成图片", "人脸替换、图片合成", "阿里云 VIAPI：MergeImageFace；图像编辑模型作为备选", "已联调，待质量验收", "待书面核验"],
        ["年龄变化", "人像照片 + 年龄方向 → 处理后人像", "人脸属性编辑", "阿里云/腾讯云人像变换接口，生产供应商待定", "候选能力", "待供应商及产品范围核验"],
        ["老照片修复与上色", "旧照片 → 增强、修复或上色图片", "图像增强、图像着色", "阿里云 VIAPI：EnhanceFace / ColorizeImage", "已联调，待质量验收", "待书面核验"],
        ["AI 头像与艺术风格", "人像照片 + 预设风格 → 风格化图片", "图像编辑、风格化生成", "阿里云百炼图像编辑模型或境内第三方模型，生产版本待定", "候选能力", "待最终模型确定后核验"],
        ["照片动态化 / 跳舞", "本人/获授权照片 + 动作模板/提示 → 视频", "图生视频、姿态驱动", "境内第三方图生视频服务，仍在选型与效果验收", "拟上线，未开放", "待最终供应商确定后核验"],
        ["分享文案", "作品类型、语气、文字描述 → 分享文案", "文本生成", "DeepSeek API：deepseek-chat（可配置替代服务）", "已联调", "模型及服务备案信息待书面核验"],
    ]
    data = [[p(h, "CNTableHead") for h in headers]] + [[p(cell, "CNTable") for cell in row] for row in rows]
    table = Table(data, colWidths=[31 * mm, 54 * mm, 32 * mm, 62 * mm, 32 * mm, 51 * mm], repeatRows=1)
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), NAVY),
                ("BACKGROUND", (0, 1), (-1, -1), WHITE),
                ("BACKGROUND", (0, 2), (-1, 2), PALE),
                ("BACKGROUND", (0, 4), (-1, 4), PALE),
                ("BACKGROUND", (0, 6), (-1, 6), PALE),
                ("BOX", (0, 0), (-1, -1), 0.6, LINE),
                ("INNERGRID", (0, 0), (-1, -1), 0.35, LINE),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 5),
                ("RIGHTPADDING", (0, 0), (-1, -1), 5),
                ("TOPPADDING", (0, 0), (-1, -1), 5),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ]
        )
    )
    story.extend(
        [
            table,
            Spacer(1, 4 * mm),
            Table(
                [[p("共同技术边界", "CNBadge"), p("全部 AI 调用由乐颜秀服务端发起；客户端不保存云厂商 API 密钥。产品不训练、不微调、不私有部署基础模型。原始人像仅发送给完成所选功能所必要的第三方服务。", "CNTable"), p("需主管部门确认", "CNBadge"), p("调用第三方模型是否需办理应用/功能登记；上述人脸替换、姿态驱动等是否需由乐颜秀另行办理深度合成算法备案；App 与小程序是否分别登记。", "CNTable")]],
                colWidths=[29 * mm, 102 * mm, 29 * mm, 102 * mm],
                style=TableStyle(
                    [
                        ("BACKGROUND", (0, 0), (0, 0), PALE_CYAN),
                        ("BACKGROUND", (2, 0), (2, 0), PALE_BLUE),
                        ("BOX", (0, 0), (-1, -1), 0.5, LINE),
                        ("INNERGRID", (0, 0), (-1, -1), 0.35, LINE),
                        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                        ("LEFTPADDING", (0, 0), (-1, -1), 6),
                        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                        ("TOPPADDING", (0, 0), (-1, -1), 6),
                        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
                    ]
                ),
            ),
        ]
    )
    doc.build(story)
    return path


def flow_box(label: str, detail: str, color=PALE_BLUE):
    return Table(
        [[p(label, "CNBadge")], [p(detail, "CNSmall")]],
        colWidths=[31 * mm],
        style=TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), color),
                ("BOX", (0, 0), (-1, -1), 0.7, BLUE),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("ALIGN", (0, 0), (-1, -1), "CENTER"),
                ("LEFTPADDING", (0, 0), (-1, -1), 5),
                ("RIGHTPADDING", (0, 0), (-1, -1), 5),
                ("TOPPADDING", (0, 0), (-1, -1), 5),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ]
        ),
    )


def build_architecture_pdf() -> Path:
    path = OUT / "附件3-乐颜秀技术架构与数据流说明.pdf"
    doc = make_doc(path, A4, "附件 3 / 架构与数据流")
    arrow = rich("<font color='#1769E0'><b>→</b></font>", "CNBadge")
    flow = Table(
        [[
            flow_box("用户端", "微信小程序 / Android App"),
            arrow,
            flow_box("乐颜秀后端", "鉴权、授权校验、任务编排"),
            arrow,
            flow_box("安全与标识", "内容审核、生成标识、审计日志", PALE_CYAN),
            arrow,
            flow_box("第三方 AI", "境内云厂商 API / 模型服务"),
            arrow,
            flow_box("结果交付", "私有存储、签名链接、用户删除"),
        ]],
        colWidths=[31 * mm, 6 * mm, 31 * mm, 6 * mm, 31 * mm, 6 * mm, 31 * mm, 6 * mm, 31 * mm],
        style=TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("ALIGN", (0, 0), (-1, -1), "CENTER"),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 0),
            ]
        ),
    )
    story = [
        p("乐颜秀技术架构与数据流说明", "CNTitle"),
        p("目标：说明 App 与小程序共用服务端时，个人信息、生成请求和生成结果如何流转，以及第三方模型处于何种角色。", "CNSubtitle"),
        p("一、总体架构", "CNH2"),
        flow,
        Spacer(1, 2 * mm),
        p("数据回程：第三方 AI 服务将任务状态和结果返回乐颜秀后端；后端完成安全处理和标识后，仅向发起任务的用户提供结果。", "CNSmall"),
        p("二、主要数据流", "CNH2"),
    ]
    headers = ["数据类别", "处理目的", "流向 / 接收方", "保存与删除设计"]
    rows = [
        ["账户与设备信息", "登录、鉴权、安全风控、订单和作品归属", "乐颜秀后端；必要时接入登录/支付服务", "按实现服务所需最短期限保存；账户注销时依法处理"],
        ["照片、人脸及视频素材", "完成用户选择的人脸融合、修复、风格化或视频生成", "乐颜秀后端 → 所选功能对应的境内云厂商 API", "任务处理所需最短期限；用户可删除作品；供应商留存由合同和生产配置约束"],
        ["文字描述与文案偏好", "生成分享文案或控制预设效果", "乐颜秀后端 → 文本/视觉模型服务", "与任务绑定；不向文本模型发送无关原始人像"],
        ["生成结果", "向用户展示、下载、分享与再次管理", "第三方 AI → 乐颜秀私有对象存储 → 用户端", "默认不公开；采用授权访问；用户可主动删除"],
        ["安全与审计日志", "故障定位、滥用防控、投诉处理、合规审计", "乐颜秀后端及必要的安全服务", "脱敏、分级授权，并在上线前确定具体保存期限"],
    ]
    data = [[p(h, "CNTableHead") for h in headers]] + [[p(cell, "CNTable") for cell in row] for row in rows]
    table = Table(data, colWidths=[32 * mm, 46 * mm, 55 * mm, 47 * mm], repeatRows=1)
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), NAVY),
                ("BACKGROUND", (0, 2), (-1, 2), PALE),
                ("BACKGROUND", (0, 4), (-1, 4), PALE),
                ("BOX", (0, 0), (-1, -1), 0.5, LINE),
                ("INNERGRID", (0, 0), (-1, -1), 0.35, LINE),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 5),
                ("RIGHTPADDING", (0, 0), (-1, -1), 5),
                ("TOPPADDING", (0, 0), (-1, -1), 5),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ]
        )
    )
    story.extend(
        [
            table,
            p("三、关键安全边界", "CNH2"),
            Table(
                [[
                    rich("<b>密钥与网络</b><br/>API 密钥仅保存在服务端；客户端不下发密钥；全链路加密传输。", "CNTable"),
                    rich("<b>存储与访问</b><br/>对象存储默认私有；短时签名访问；作品与账户绑定；日志不记录密钥。", "CNTable"),
                    rich("<b>供应商治理</b><br/>上线前核验境内部署、模型/算法备案信息、日志留存、训练使用和转委托规则。", "CNTable"),
                ]],
                colWidths=[60 * mm, 60 * mm, 60 * mm],
                style=TableStyle(
                    [
                        ("BACKGROUND", (0, 0), (-1, -1), PALE_CYAN),
                        ("BOX", (0, 0), (-1, -1), 0.5, LINE),
                        ("INNERGRID", (0, 0), (-1, -1), 0.35, LINE),
                        ("VALIGN", (0, 0), (-1, -1), "TOP"),
                        ("LEFTPADDING", (0, 0), (-1, -1), 7),
                        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
                        ("TOPPADDING", (0, 0), (-1, -1), 7),
                        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
                    ]
                ),
            ),
        ]
    )
    doc.build(story)
    return path


EMAIL = """收件人：jsc@bjwxb.beijing.gov.cn
邮件主题：关于“乐颜秀”调用第三方生成式人工智能模型 API 的应用登记及深度合成算法备案咨询

尊敬的北京市互联网信息办公室相关负责同志：

您好！

我司REDACTED_COMPANY_NAME（统一社会信用代码：REDACTED_COMPANY_REGISTRATION）正在开发“乐颜秀”产品，拟以微信小程序和 Android App 两种形态向境内个人用户提供 AI 图片、AI 视频及分享文案生成服务。目前产品处于封闭测试与合规准备阶段。为准确履行生成式人工智能服务及深度合成相关合规义务，现就具体适用路径向贵办咨询。

一、产品与技术情况

1. 我司不自研、不训练、不微调、不私有部署基础模型，不向用户提供模型训练或开放式模型调用能力；AI 能力均由我司服务端调用境内第三方云厂商的模型或算法 API 完成。
2. 拟提供的主要功能包括：视频模板人脸融合、图片人脸融合、年龄变化、老照片修复与上色、AI 头像与艺术风格、照片动态化/跳舞、图生视频，以及根据作品描述生成分享文案。部分能力仍处于供应商选型和质量验收阶段。
3. 用户上传本人或已获授权的人像素材，选择运营方提供的模板或预设效果后生成个人作品。产品不设用户公开发布、公开主页、关注、粉丝、评论或用户内容推荐社区；生成作品默认仅在用户个人账户内可见。用户可主动保存至本地，或调用系统分享能力发送至外部平台。
4. 微信小程序和 Android App 计划共用同一套后端、供应商接口和内容安全机制，仅客户端载体不同。
5. 我司拟在上线前完成供应商及模型/算法备案信息核验、个人信息与人脸信息单独同意、内容安全审核、生成合成内容显著及隐式标识、投诉举报、作品删除和供应商数据处理约束等措施。

二、咨询事项

1. 在上述“不自研模型，仅通过服务端调用第三方模型/算法 API”的情况下，“乐颜秀”是否属于需要办理生成式人工智能应用/功能登记的应用？如需办理，适用的事项名称、受理条件和办理入口是什么？
2. 微信小程序与 Android App 共用同一运营主体、同一后端和同一 AI 能力时，可否作为同一应用/服务一并登记，还是需要按客户端形态分别登记？后续新增 iOS 客户端时应如何处理？
3. 视频/图片人脸融合、年龄变化、照片动态化/跳舞和姿态驱动等功能，是否还需要由我司另行办理深度合成算法备案？若第三方云厂商已就底层模型或算法完成备案，我司作为应用运营方是否仍需单独备案或履行其他登记、报送义务？
4. 产品无用户公开社区、无站内公开发布，生成结果默认仅向任务发起人展示；用户主动下载或通过系统分享至外部平台。该产品形态是否属于具有舆论属性或者社会动员能力的服务，判断时应以哪些因素为准？
5. 如需办理相关登记、备案或安全评估，烦请告知当前有效的材料清单、申请表模板、线上/线下提交方式，以及是否可以先行进行书面预判或材料预审。

随邮件附上：
1. 《乐颜秀产品说明》；
2. 《乐颜秀 AI 能力与第三方服务清单》；
3. 《乐颜秀技术架构与数据流说明》。

为避免提供不准确的信息，附件中的具体供应商、生产模型版本和备案编号均标注了当前核验状态；如贵办需要，我司可在供应商书面确认后补充合同、接口说明、备案信息、产品截图及测试账号。

感谢指导，盼复。

REDACTED_COMPANY_NAME
联系人：【请填写】
职务：【请填写】
手机：【请填写】
公司邮箱：【请填写】
通讯地址：【请填写】
日期：2026年9月14日
"""


CHECKLIST = """乐颜秀北京市网信办咨询邮件 - 发送前检查清单

1. 使用公司邮箱发送，建议同时抄送公司法务/负责人留档。
2. 补全邮件末尾的联系人、职务、手机、公司邮箱和通讯地址。
3. 确认公司全称、统一社会信用代码与营业执照完全一致。
4. 复核附件 2：只保留确实计划上线的功能；供应商未确认的备案号不要自行填写。
5. 不在邮件或附件中提供 API Key、账号密码、AccessKey、测试请求日志中的令牌或身份证件原图。
6. 发送后保留邮件原文、发送时间、送达/退信记录和三个附件的最终版本。
7. 若 3 至 5 个工作日无回复，可将本邮件内容及发送记录提交北京 12345 网上咨询，请转北京市互联网信息办公室答复。
"""


def write_text_files() -> tuple[Path, Path]:
    email_path = OUT / "邮件正文-直接发送.txt"
    checklist_path = OUT / "发送前检查清单.txt"
    email_path.write_text(EMAIL, encoding="utf-8-sig")
    checklist_path.write_text(CHECKLIST, encoding="utf-8-sig")
    return email_path, checklist_path


def main() -> None:
    pdfs = [build_product_pdf(), build_capability_pdf(), build_architecture_pdf()]
    email_path, checklist_path = write_text_files()
    zip_path = OUT / "北京市网信办咨询邮件材料包-2026-09-14.zip"
    with ZipFile(zip_path, "w", ZIP_DEFLATED) as archive:
        for file_path in [email_path, checklist_path, *pdfs]:
            archive.write(file_path, arcname=file_path.name)
    for item in [email_path, checklist_path, *pdfs, zip_path]:
        print(item)


if __name__ == "__main__":
    main()
