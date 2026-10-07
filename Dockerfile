FROM node:20-alpine

ENV NODE_ENV=production \
    PORT=7800 \
    DATA_DIR=/data

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .
RUN chmod +x docker/entrypoint.sh && mkdir -p /data && chown -R node:node /app /data

USER node
VOLUME ["/data"]
EXPOSE 7800

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/health >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["node", "server.js"]
