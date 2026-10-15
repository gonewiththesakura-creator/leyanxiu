# Official Node config inspected 2026-10-10: Node 22.23.3, Linux amd64.
# This digest pins the base, not subsequent Debian apt repository contents.
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
COPY --chown=node:node media-validation.js mark-ai.py normalize-photo-input.py manifest.json runtime-image.json ./
ENV NODE_ENV=production PORT=3000 \
    DEBUG="" NODE_DEBUG="" NODE_DEBUG_NATIVE="" \
    NODE_EXTRA_CA_CERTS=/app/cert/certificate.crt \
    PYTHON_PATH=/usr/bin/python3 AI_MARK_FONT=/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc \
    RELEASE_CHANNEL=wechat-mini-program AUTH_MODE=wechat \
    XPAY_ENABLED=true XPAY_ENV=1 XPAY_DB_BACKEND=mysql XPAY_MODE=closed XPAY_RECONCILE_ENABLED=false \
    PHOTO_CANDIDATE_GENERATION_ENABLED=false PHOTO_CANDIDATE_PROCESS_ENABLED=false PHOTO_CANDIDATE_CLEANUP_ENABLED=false
USER node
# No credentials/config are present. These checks must not start the service.
RUN python3 mark-ai.py --check-font \
    && python3 normalize-photo-input.py --check \
    && node --check photo-jobs/candidate-server.js \
    && node --input-type=module -e "await import('./photo-jobs/candidate-server.js')"
EXPOSE 3000
CMD ["node", "photo-jobs/candidate-server.js"]
