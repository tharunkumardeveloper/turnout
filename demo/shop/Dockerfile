# The demo shop on its own: plain Node, no dependencies, nothing but demo/shop.
# Build from the repo root: docker build -f demo/shop/Dockerfile -t ridgeline-shop .
FROM node:24-alpine
WORKDIR /app
COPY demo/shop ./demo/shop
USER node
EXPOSE 8080
ENTRYPOINT ["node", "demo/shop/server.ts"]
