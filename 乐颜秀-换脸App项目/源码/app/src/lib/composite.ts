import type { Template } from "@/data/templates";

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/**
 * 换脸合成引擎（演示版）：
 * 将用户照片的中心人脸区域，以羽化椭圆蒙版融合进模板封面的脸部锚点，
 * 并叠加肤色适配、内阴影与 AI 水印，模拟真实换脸效果。
 */
export async function compositeFace(
  template: Template,
  photoSrc: string
): Promise<string> {
  const [cover, photo] = await Promise.all([
    loadImage(template.cover),
    loadImage(photoSrc),
  ]);

  const W = cover.width;
  const H = cover.height;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;

  // 1. 绘制模板底图
  ctx.drawImage(cover, 0, 0);

  // 2. 计算脸部锚点
  const cx = template.anchor.fx * W;
  const cy = template.anchor.fy * H;
  const rw = template.anchor.fr * W * 0.78; // 椭圆半宽
  const rh = template.anchor.fr * W * 1.08; // 椭圆半高

  // 3. 从用户照片中裁剪中心方形区域（假定人脸居中）
  const side = Math.min(photo.width, photo.height);
  const sx = (photo.width - side) / 2;
  const sy = (photo.height - side) / 2 - side * 0.06; // 略向上取，对准面部

  // 4. 羽化蒙版：先离屏绘制人脸，再用径向渐变为边缘羽化
  const faceCanvas = document.createElement("canvas");
  faceCanvas.width = W;
  faceCanvas.height = H;
  const fctx = faceCanvas.getContext("2d")!;

  fctx.save();
  fctx.beginPath();
  fctx.ellipse(cx, cy, rw, rh, 0, 0, Math.PI * 2);
  fctx.clip();
  // 略微提亮+柔化，模拟光影适配
  fctx.filter = "brightness(1.04) saturate(1.05)";
  fctx.drawImage(
    photo,
    sx,
    Math.max(0, sy),
    side,
    side,
    cx - rw,
    cy - rh,
    rw * 2,
    rh * 2
  );
  fctx.restore();

  // 边缘羽化
  fctx.globalCompositeOperation = "destination-in";
  const grad = fctx.createRadialGradient(cx, cy, rw * 0.45, cx, cy, rh * 1.12);
  grad.addColorStop(0, "rgba(0,0,0,1)");
  grad.addColorStop(0.72, "rgba(0,0,0,0.95)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  fctx.fillStyle = grad;
  fctx.fillRect(0, 0, W, H);

  // 5. 融合到底图
  ctx.drawImage(faceCanvas, 0, 0);

  // 6. 脸部下缘轻微环境光，让肤色与场景光统一
  ctx.save();
  ctx.globalCompositeOperation = "overlay";
  const env = ctx.createRadialGradient(cx, cy, rw * 0.2, cx, cy, rh * 1.3);
  env.addColorStop(0, "rgba(255,220,200,0.06)");
  env.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = env;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();

  // 7. AI 生成水印（合规标识）
  ctx.save();
  ctx.font = `500 ${Math.round(W * 0.032)}px sans-serif`;
  ctx.fillStyle = "rgba(255,255,255,0.75)";
  ctx.textAlign = "right";
  ctx.fillText("AI制作 · 乐颜秀", W - 20, H - 22);
  ctx.restore();

  return canvas.toDataURL("image/jpeg", 0.9);
}
