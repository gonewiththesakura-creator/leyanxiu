# 乐颜秀接入服务 · ECS/容器通用镜像
# 包含：Node 运行时 + ffmpeg（视频合成）+ Python/PIL（证件照合成）
FROM node:20-bookworm-slim

# ffmpeg：maskedmerge 合成；python3 + PIL：证件照换底/排版（apt 装 PIL 避免 pip 网络风险）
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg python3 python3-pil fonts-noto-cjk fonts-dejavu-core ca-certificates \
  && ln -sf /usr/bin/python3 /usr/local/bin/python \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund --registry=https://registry.npmmirror.com

COPY --chown=node:node . .

# Reject images whose installed Pillow/font cannot render the visible Chinese AI label.
RUN python3 mark-ai.py --check-font

RUN mkdir -p /var/lib/leyanxiu/data /var/lib/leyanxiu/reports /tmp/leyanxiu \
  && chown -R node:node /var/lib/leyanxiu /tmp/leyanxiu

# 宿主机 Nginx 仅通过 127.0.0.1:3000 访问容器。
ENV NODE_ENV=production PORT=3000
EXPOSE 3000

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "bootstrap.js"]
