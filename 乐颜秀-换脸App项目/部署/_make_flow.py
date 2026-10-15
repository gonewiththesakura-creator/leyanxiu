# -*- coding: utf-8 -*-
"""生成算法流程图（自评估报告 一（一）算法流程 用）"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(sys.executable).parent.parent.parent))
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch
from daimon_runtime import setup_plot
setup_plot()

fig, ax = plt.subplots(figsize=(11, 6.5), dpi=160)
ax.set_xlim(0, 11)
ax.set_ylim(0, 6.5)
ax.axis("off")

C_USER = "#E8F0FE"
C_PROC = "#E6F4EA"
C_GEN = "#FFF4E5"
C_OUT = "#F3E8FD"
EDGE = "#5B6B7F"

def box(x, y, w, h, text, fc, fs=10.5):
    ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.06",
                                fc=fc, ec=EDGE, lw=1.2))
    ax.text(x + w / 2, y + h / 2, text, ha="center", va="center",
            fontsize=fs, linespacing=1.5)

def arrow(x1, y1, x2, y2):
    ax.add_patch(FancyArrowPatch((x1, y1), (x2, y2), arrowstyle="-|>",
                                 mutation_scale=14, color=EDGE, lw=1.4))

# 第一行：输入链路
box(0.25, 4.7, 1.85, 1.25, "用户在微信小程序\n选择玩法\n上传人像照片", C_USER)
box(2.45, 4.7, 1.85, 1.25, "内容安全审核\n（违规图片/文本\n直接拦截）", C_PROC)
box(4.65, 4.7, 1.85, 1.25, "人脸检测与预处理\n（正脸/数量校验\n压缩转码）", C_PROC)
box(6.85, 4.7, 1.85, 1.25, "按玩法路由至\n第三方已备案\n深度合成算法", C_GEN)
box(9.0, 4.7, 1.75, 1.25, "生成结果\n二次机审", C_PROC)

# 第二行：第三方算法明细
box(0.25, 2.45, 2.5, 1.25, "阿里云·达摩院图像合成\n（视频/照片换脸\n老照片修复）", C_GEN, 9.5)
box(3.0, 2.45, 2.5, 1.25, "火山方舟·豆包\nSeedream 图像生成\n（动漫化/换背景/写真）", C_GEN, 9.5)
box(5.75, 2.45, 2.5, 1.25, "腾讯云·人像变换\n（减龄/变老）\nAI 绘画（写真）", C_GEN, 9.5)
box(8.5, 2.45, 2.5, 1.25, "火山·AI 多媒体套件\n腾讯·混元生视频\n（视频换脸备用）", C_GEN, 9.5)

# 第三行：输出链路
box(2.0, 0.35, 2.6, 1.15, "添加显式标识\n「AI生成」水印角标\n（强制开启）", C_OUT)
box(5.1, 0.35, 2.3, 1.15, "隐式标识与溯源\n（任务日志留存\n文件元数据）", C_OUT)
box(7.9, 0.35, 2.6, 1.15, "转存自有对象存储\n返回小程序\n展示/保存/分享", C_OUT)

# 连线
arrow(2.1, 5.32, 2.45, 5.32)
arrow(4.3, 5.32, 4.65, 5.32)
arrow(6.5, 5.32, 6.85, 5.32)
arrow(8.7, 5.32, 9.0, 5.32)
# 路由节点到各第三方
for x in (1.5, 4.25, 7.0, 9.75):
    arrow(7.77, 4.7, x, 3.7)
# 第三方汇聚到二次机审（经结果回流）
for x in (1.5, 4.25, 7.0, 9.75):
    arrow(x, 2.45, 9.9, 4.7)
# 机审到输出
arrow(9.9, 4.7, 9.2, 1.5)
arrow(7.9, 0.92, 7.4, 0.92)
arrow(5.1, 0.92, 4.6, 0.92)

ax.set_title("乐颜秀人像图像视频生成合成算法 · 服务链路流程图", fontsize=13, pad=12)
fig.savefig(r"REDACTED_LOCAL_USER_PATH\Documents\kimi\workspace\乐颜秀-换脸App项目\部署\_flow.png", bbox_inches="tight")
print("flow saved")
