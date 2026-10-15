# -*- coding: utf-8 -*-
"""
模板选品筛选器：检测候选模板视频里「手遮挡脸」的严重程度。
批量跑一个目录，输出每条素材的遮挡报告和取舍建议。

用法:
  python screen-template.py <视频文件或目录> [更多文件...]

判定规则（可按需调整）:
  遮挡率 = 手与脸的包围盒重叠面积 / 脸面积
  - 峰值 ≥25% 或 累计遮挡 ≥0.5秒 → ✗ 不建议（重影高危）
  - 峰值 ≥10% 或 累计遮挡 ≥0.2秒 → △ 边缘（贴脸小动作多，人眼复核）
  - 其余                            → ✓ 安全
注意：只检测「手」遮挡。话筒/扇子/眼镜等道具遮挡检不到，终稿前仍需人眼过一遍。
"""
import os
import sys
import glob
import cv2
import numpy as np
import mediapipe as mp
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision

HAND_MODEL = os.environ.get("HAND_MODEL", r"REDACTED_LOCAL_USER_PATH\.leyanxiu\hand_landmarker.task")
FACE_MODEL = os.environ.get("FACE_MODEL", r"REDACTED_LOCAL_USER_PATH\.leyanxiu\blaze_face_short_range.tflite")

SAMPLE_EVERY = 3          # 每3帧采样一次（速度/精度平衡）
HARD_PEAK, HARD_SECS = 0.25, 0.5
WARN_PEAK, WARN_SECS = 0.10, 0.2


def screen(video_path):
    hand_det = vision.HandLandmarker.create_from_options(vision.HandLandmarkerOptions(
        base_options=mp_python.BaseOptions(model_asset_path=HAND_MODEL),
        running_mode=vision.RunningMode.VIDEO, num_hands=2,
        min_hand_detection_confidence=0.3, min_hand_presence_confidence=0.3, min_tracking_confidence=0.3))
    face_det = vision.FaceDetector.create_from_options(vision.FaceDetectorOptions(
        base_options=mp_python.BaseOptions(model_asset_path=FACE_MODEL),
        running_mode=vision.RunningMode.VIDEO, min_detection_confidence=0.4))

    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    peak = 0.0
    occluded_frames = 0
    sampled = 0
    fi = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if fi % SAMPLE_EVERY == 0:
            sampled += 1
            h, w = frame.shape[:2]
            small = cv2.resize(frame, (w // 2, h // 2))
            mp_img = mp.Image(image_format=mp.ImageFormat.SRGB,
                              data=cv2.cvtColor(small, cv2.COLOR_BGR2RGB))
            ts = int(fi * 1000 / fps)
            fr = face_det.detect_for_video(mp_img, ts)
            hr = hand_det.detect_for_video(mp_img, ts)
            if fr.detections and hr.hand_landmarks:
                bb = fr.detections[0].bounding_box
                fx1, fy1 = bb.origin_x * 2, bb.origin_y * 2
                fx2, fy2 = fx1 + bb.width * 2, fy1 + bb.height * 2
                for lm in hr.hand_landmarks:
                    pts = np.array([[p.x * w, p.y * h] for p in lm])
                    hx1, hy1 = pts.min(0)
                    hx2, hy2 = pts.max(0)
                    ix = max(0, min(fx2, hx2) - max(fx1, hx1))
                    iy = max(0, min(fy2, hy2) - max(fy1, hy1))
                    ratio = (ix * iy) / max(1, (fx2 - fx1) * (fy2 - fy1))
                    peak = max(peak, ratio)
                    if ratio > 0.05:
                        occluded_frames += 1
        fi += 1
    cap.release()
    hand_det.close(); face_det.close()

    occ_secs = occluded_frames * SAMPLE_EVERY / fps
    total_secs = fi / fps
    if peak >= HARD_PEAK or occ_secs >= HARD_SECS:
        verdict = "✗ 不建议"
    elif peak >= WARN_PEAK or occ_secs >= WARN_SECS:
        verdict = "△ 边缘"
    else:
        verdict = "✓ 安全"
    return dict(total=total_secs, peak=peak, occ=occ_secs, verdict=verdict)


def main():
    paths = []
    for arg in sys.argv[1:]:
        if os.path.isdir(arg):
            for ext in ("*.mp4", "*.mov", "*.MP4", "*.MOV"):
                paths += glob.glob(os.path.join(arg, ext))
        else:
            paths.append(arg)
    if not paths:
        print(__doc__)
        return
    print(f"{'素材':<44} {'时长':>6} {'峰值遮挡':>8} {'累计遮挡':>8}  结论")
    print("-" * 86)
    for p in paths:
        try:
            r = screen(p)
            name = os.path.basename(p)
            print(f"{name:<44} {r['total']:>5.1f}s {r['peak']*100:>7.0f}% {r['occ']:>7.2f}s  {r['verdict']}")
        except Exception as e:
            print(f"{os.path.basename(p):<44}  检测失败: {e}")


if __name__ == "__main__":
    main()
