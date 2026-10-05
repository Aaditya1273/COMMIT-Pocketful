# Pocketful stage 4 — zero runtime dependencies; API (incl. ledger, refunds, correction batches) and browser UI ship in this image.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    UV_THREADPOOL_SIZE=8
COPY package.json ./
COPY src ./src
USER node
EXPOSE 8080
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O - "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1
CMD ["node", "src/server.js"]
