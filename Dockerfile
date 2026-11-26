# Turnout: the proxy, the console and the CLI. The demo shop has its own image (demo/shop/Dockerfile).
FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY demo ./demo
# No turnout.config.yml: it's mounted at /app/turnout.config.yml. compose.flagsmith.yml is what
# "turnout new" writes next to your app when you want Flagsmith bundled.
COPY compose.flagsmith.yml ./
# Owned by node so the named state volume (the last known live release) is writable.
RUN mkdir -p /app/.turnout && chown node:node /app/.turnout
USER node
ENTRYPOINT ["node", "src/cli.ts"]
CMD ["proxy"]
