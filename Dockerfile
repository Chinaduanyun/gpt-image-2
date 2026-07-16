FROM node:22-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/data

WORKDIR /app

COPY --chown=node:node package.json ./
COPY --chown=node:node server.js index.html styles.css workspace.css workspace-shell.js config.example.js ./
COPY --chown=node:node app ./app
COPY --chown=node:node lib ./lib
COPY --chown=node:node routes ./routes

RUN mkdir -p /data && chown node:node /data

USER node

EXPOSE 8787
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "require('node:http').get('http://127.0.0.1:8787/',r=>{r.resume();process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"]

CMD ["npm", "start"]
