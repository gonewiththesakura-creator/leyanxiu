# -*- coding: utf-8 -*-
"""生成语音合成算法流程图（B 备案自评估报告 一（一）算法流程 用）"""
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
box(0.25, 4.7, 1.85, 1.25, "用户在小程序\n选择语音玩法\n输入文本/朗读录音", C_USER)
box(2.45, 4.7, 1.85, 1.25, "内容安全审核\n（文本 msgSecCheck\n音频安全检测）", C_PROC)
box(4.65, 4.7, 1.85, 1.25, "本人校验\n（活体检测+\n声纹一致性校验）", C_PROC)
box(6.85, 4.7, 1.85, 1.25, "按玩法路由至\n第三方已备案\n语音合成算法", C_GEN)
box(9.0, 4.7, 1.75, 1.25, "生成音频\n二次审核", C_PROC)

# 第二行：第三方算法明细
box(0.85, 2.45, 2.9, 1.25, "火山引擎·文本转语音算法\n（AI 配音/声音复刻·主\n网信算备110108823483901230057号）", C_GEN, 8.5)
box(4.05, 2.45, 2.9, 1.25, "腾讯云·语音合成算法\n（文本转语音·备\n网信算备440305295988701230039号）", C_GEN, 8.5)
box(7.25, 2.45, 2.9, 1.25, "豆包企业版·实时语音模型\n（声音复刻 2.0·候选\n网信算备110108823483901250177号）", C_GEN, 8.5)

# 第三行：输出链路
box(2.0, 0.35, 2.6, 1.15, "添加显式标识\n音频开头语音提示\n+页面文字标识", C_OUT)
box(5.1, 0.35, 2.3, 1.15, "隐式标识与溯源\n（任务日志留存\n文件元数据）", C_OUT)
box(7.9, 0.35, 2.6, 1.15, "转存自有对象存储\n返回小程序\n播放/保存/分享", C_OUT)

# 连线
arrow(2.1, 5.32, 2.45, 5.32)
arrow(4.3, 5.32, 4.65, 5.32)
arrow(6.5, 5.32, 6.85, 5.32)
arrow(8.7, 5.32, 9.0, 5.32)
# 路由节点到各第三方
for x in (2.3, 5.5, 8.7):
    arrow(7.77, 4.7, x, 3.7)
# 第三方汇聚到二次审核
for x in (2.3, 5.5, 8.7):
    arrow(x, 2.45, 9.9, 4.7)
# 机审到输出
arrow(9.9, 4.7, 9.2, 1.5)
arrow(7.9, 0.92, 7.4, 0.92)
arrow(5.1, 0.92, 4.6, 0.92)

ax.set_title("乐颜秀语音合成算法 · 服务链路流程图", fontsize=13, pad=12)
fig.savefig(r"REDACTED_LOCAL_USER_PATH\Documents\kimi\workspace\乐颜秀-换脸App项目\部署\_flow_voice.png", bbox_inches="tight")
print("flow saved")
