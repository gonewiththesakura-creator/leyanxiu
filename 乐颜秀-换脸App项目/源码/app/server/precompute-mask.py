# -*- coding: utf-8 -*-
"""
模板手部遮挡 mask 预计算（模板入库时跑一次，离线，CPU）
输出灰度 mask 视频：255=手部（回贴原片），0=保留换脸结果，边缘羽化。
出片时 ffmpeg maskedmerge 直接消费，无需再跑 ML。

用法:
  python precompute-mask.py <模板视频> <输出mask.mp4>
"""
import os
import sys
import cv2
import numpy as np
import mediapipe as mp
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision
from pathlib import Path

# MediaPipe 在 Windows 下打不开含中文的路径，模型固定放纯英文目录
MODEL = os.environ.get("HAND_MODEL", r"REDACTED_LOCAL_USER_PATH\.leyanxiu\hand_landmarker.task")


def main():
    src_path, out_path = sys.argv[1], sys.argv[2]
    cap = cv2.VideoCapture(src_path)
    fps = cap.get(cv2.CAP_PROP_FPS)
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    out = cv2.VideoWriter(out_path, cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h), isColor=False)
    detector = vision.HandLandmarker.create_from_options(vision.HandLandmarkerOptions(
        base_options=mp_python.BaseOptions(model_asset_path=MODEL),
        running_mode=vision.RunningMode.VIDEO,
        num_hands=2,
        min_hand_detection_confidence=0.3,
        min_hand_presence_confidence=0.3,
        min_tracking_confidence=0.3,
    ))

    prev_mask = None
    fi = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        small = cv2.resize(frame, (w // 2, h // 2))
        rgb = cv2.cvtColor(small, cv2.COLOR_BGR2RGB)
        mp_img = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
        res = detector.detect_for_video(mp_img, int(fi * 1000 / fps))

        mask = np.zeros((h, w), np.uint8)
        for lm in res.hand_landmarks:
            pts = np.array([[p.x * w, p.y * h] for p in lm], np.int32)
            cv2.fillConvexPoly(mask, cv2.convexHull(pts), 255)
            wrist, mid = pts[0], pts[9]
            cv2.line(mask, tuple(wrist), tuple(wrist + (wrist - mid)), 255, thickness=80)
        if mask.max() == 0 and prev_mask is not None:
            mask = prev_mask
        mask = cv2.dilate(mask, np.ones((21, 21), np.uint8))
        mask = cv2.GaussianBlur(mask, (31, 31), 0)
        prev_mask = mask

        out.write(mask)
        fi += 1
        if fi % 60 == 0:
            print(f"{fi} frames...")

    cap.release(); out.release(); detector.close()
    print(f"done: {fi} frames -> {out_path}")


if __name__ == "__main__":
    main()
