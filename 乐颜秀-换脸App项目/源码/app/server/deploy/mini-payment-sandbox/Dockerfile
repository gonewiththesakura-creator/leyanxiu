FROM node:22-bookworm-slim
WORKDIR /app
# WeChat CloudRun's OpenAPI sidecar installs its per-container CA here.
# Extend Node's trust store; keep TLS chain and hostname verification enabled.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --chown=node:node payments ./payments
USER node
ENV NODE_ENV=production PORT=3000 NODE_EXTRA_CA_CERTS=/app/cert/certificate.crt
EXPOSE 3000
CMD ["node", "payments/virtual/mini-sandbox-server.js"]
