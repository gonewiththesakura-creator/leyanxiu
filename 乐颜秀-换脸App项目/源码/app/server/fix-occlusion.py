# -*- coding: utf-8 -*-
"""
遮挡回贴修复 PoC：
换脸 API 会把融合脸贴在「原本挡在脸前的手」上面（脸压手/重影）。
修复思路：用 MediaPipe 在【原视频】里检测手部区域，把原视频的手部像素
回贴到换脸结果上。手部像素从未被换脸改动过，所以无缝。

模板化产品架构下，这个 mask 只需在模板入库时对每个模板算一次，
存成 mask 轨道；出片时纯合成，零 ML 零 GPU。
"""
import sys
import cv2
import numpy as np
import mediapipe as mp
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision

MODEL = "compare-output/hand_landmarker.task"


def make_detector():
    options = vision.HandLandmarkerOptions(
        base_options=mp_python.BaseOptions(model_asset_path=MODEL),
        running_mode=vision.RunningMode.VIDEO,
        num_hands=2,
        min_hand_detection_confidence=0.3,
        min_hand_presence_confidence=0.3,
        min_tracking_confidence=0.3,
    )
    return vision.HandLandmarker.create_from_options(options)


def hand_mask(detector, frame, ts_ms, prev_mask=None):
    h, w = frame.shape[:2]
    small = cv2.resize(frame, (w // 2, h // 2))  # 半分辨率检测，速度x4
    rgb = cv2.cvtColor(small, cv2.COLOR_BGR2RGB)
    mp_img = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
    res = detector.detect_for_video(mp_img, ts_ms)
    mask = np.zeros((h, w), np.uint8)
    for lm in res.hand_landmarks:
        pts = np.array([[p.x * w, p.y * h] for p in lm], np.int32)
        hull = cv2.convexHull(pts)
        cv2.fillConvexPoly(mask, hull, 255)
        # 手腕点往小臂方向再补一块
        wrist = pts[0]
        mid = pts[9]
        ext = wrist + (wrist - mid)
        cv2.line(mask, tuple(wrist), tuple(ext), 255, thickness=80)
    if mask.max() == 0 and prev_mask is not None:
        mask = prev_mask  # 检测失败沿用上一帧，避免闪烁
    mask = cv2.dilate(mask, np.ones((21, 21), np.uint8))
    mask = cv2.GaussianBlur(mask, (31, 31), 0)
    return mask


def main():
    src_path, swap_path, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
    t0, t1 = float(sys.argv[4]), float(sys.argv[5])
    demo_frames = [float(x) for x in sys.argv[6].split(",")] if len(sys.argv) > 6 else []

    src = cv2.VideoCapture(src_path)
    swap = cv2.VideoCapture(swap_path)
    fps = src.get(cv2.CAP_PROP_FPS)
    w = int(src.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(src.get(cv2.CAP_PROP_FRAME_HEIGHT))

    out = cv2.VideoWriter(out_path, cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))
    detector = make_detector()

    f0, f1 = int(t0 * fps), int(t1 * fps)
    src.set(cv2.CAP_PROP_POS_FRAMES, f0)
    swap.set(cv2.CAP_PROP_POS_FRAMES, f0)

    prev_mask = None
    n = 0
    for fi in range(f0, f1):
        ok1, fo = src.read()
        ok2, fs = swap.read()
        if not (ok1 and ok2):
            break
        m = hand_mask(detector, fo, int(fi * 1000 / fps), prev_mask)
        prev_mask = m
        m3 = (m.astype(np.float32) / 255.0)[:, :, None]
        fixed = (fs * (1 - m3) + fo * m3).astype(np.uint8)
        out.write(fixed)

        t = fi / fps
        if any(abs(t - d) < 0.5 / fps for d in demo_frames):
            tri = np.hstack([cv2.resize(x, (480, 853)) for x in [fs, fo, fixed]])
            cv2.putText(tri, "swapped (bug)", (10, 40), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 255, 255), 2)
            cv2.putText(tri, "original", (490, 40), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 255, 255), 2)
            cv2.putText(tri, "fixed", (970, 40), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 255, 255), 2)
            cv2.imwrite(f"compare-output/fix-{t:.1f}.jpg", tri, [cv2.IMWRITE_JPEG_QUALITY, 90])
            print(f"demo frame @{t:.1f}s")
        n += 1
        if n % 30 == 0:
            print(f"{n} frames...")

    src.release(); swap.release(); out.release(); detector.close()
    print(f"done: {n} frames -> {out_path}")


if __name__ == "__main__":
    main()
