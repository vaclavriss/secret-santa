FROM node:24-alpine
WORKDIR /app
COPY server/server.mjs server/server.mjs
COPY index.html index.html
ENV PORT=8080 DATA_DIR=/data PAGE=/app/index.html NODE_NO_WARNINGS=1
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "server/server.mjs"]
