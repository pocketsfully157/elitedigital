FROM node:24-bookworm-slim
WORKDIR /app
COPY --chown=node:node . .
RUN mkdir -p /app/storage && chown node:node /app/storage
USER node
ENV HOST=0.0.0.0 PORT=3000 DB_PATH=/app/storage/store.sqlite
EXPOSE 3000
CMD ["node", "server.mjs"]
