# The landing page example on its own: plain Node, no dependencies, no Flagsmith.
# Build from the repo root: docker build -f demo/landing/Dockerfile -t landing:1 --build-arg VERSION=1 .
FROM node:24-alpine
ARG VERSION=1
ENV LANDING_VERSION=${VERSION}
WORKDIR /app
COPY demo/landing ./demo/landing
USER node
EXPOSE 8080
ENTRYPOINT ["node", "demo/landing/server.ts"]
