# Same reviewed Linux amd64 base as the separate candidate package.
# Debian package versions are recorded at build time, not pinned by this digest.
FROM node:22-bookworm-slim@sha256:efd0ab5780c2d9ab1f0f869571a00d5edb17793bff4cce4a2792e3eb0ffc7562
WORKDIR /app
RUN test "$(node --version)" = "v22.23.3" \
    && test "$(dpkg --print-architecture)" = "amd64" \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates python3 python3-pil fonts-noto-cjk \
    && dpkg-query -W ca-certificates python3 python3-pil fonts-noto-cjk > /app/runtime-os-packages.txt \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY --chown=node:node payments/virtual/*.js ./payments/virtual/
COPY --chown=node:node photo-jobs/*.js ./photo-jobs/
COPY --chown=node:node media-validation.js mark-ai.py manifest.json runtime-image.json ./
ENV NODE_ENV=production PORT=3000 \
    DEBUG="" NODE_DEBUG="" NODE_DEBUG_NATIVE="" \
    NODE_EXTRA_CA_CERTS=/app/cert/certificate.crt \
    PYTHON_PATH=/usr/bin/python3 AI_MARK_FONT=/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc \
    RELEASE_CHANNEL=wechat-mini-program AUTH_MODE=wechat \
    XPAY_ENABLED=true XPAY_ENV=0 XPAY_DB_BACKEND=mysql XPAY_MODE=closed XPAY_RECONCILE_ENABLED=false \
    PHOTO_PRODUCTION_GENERATION_ENABLED=false PHOTO_PRODUCTION_PROCESS_ENABLED=false PHOTO_PRODUCTION_CLEANUP_ENABLED=false \
    PHOTO_CANDIDATE_GENERATION_ENABLED=false PHOTO_CANDIDATE_PROCESS_ENABLED=false PHOTO_CANDIDATE_CLEANUP_ENABLED=false
USER node
# Import checks must not construct SDKs, connect a database or start listeners.
RUN python3 mark-ai.py --check-font \
    && node --check photo-jobs/production-bootstrap.js \
    && node --input-type=module -e "const { materializePhotoProductionFiles } = await import('./photo-jobs/production-bootstrap.js'); const { createHash } = await import('node:crypto'); const bytes = Buffer.from('{}'); const files = materializePhotoProductionFiles({ env: { PHOTO_PRODUCTION_CONFIG_BASE64: bytes.toString('base64'), PHOTO_PRODUCTION_CONFIG_SHA256: createHash('sha256').update(bytes).digest('hex') } }); files.cleanup()"
EXPOSE 3000
CMD ["node", "photo-jobs/production-bootstrap.js"]
