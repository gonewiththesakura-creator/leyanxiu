FROM node:22.23.1-bookworm-slim
WORKDIR /app
COPY package.json ./
COPY payments/virtual/ ./payments/virtual/
ENV NODE_ENV=production PORT=3000 XPAY_MODE=closed XPAY_ENABLED=false
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "payments/virtual/callback-server.js"]
