# syntax=docker.io/docker/dockerfile:1.27.0@sha256:bde3983e9c939224420ddaf6b784cc30e09b035a4dea01f581230c50809f372e

FROM docker.io/oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS builder
WORKDIR /src
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile --production
COPY tsconfig.json ./
COPY app/ app/
COPY scripts/build.ts scripts/build.ts
RUN bun scripts/build.ts

FROM ghcr.io/acidghost/yt-dlp-oci:2026.8.19-0@sha256:62949015c7aae0359c6278ae031b68e1db03a8f853c4983b12960f6702ed468b
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*
COPY --from=builder /src/dist/yt-dlp-web /usr/local/bin/yt-dlp-web
ENV HOST=0.0.0.0 PORT=3000 DATA_DIR=/data DENO_DIR=/data/.deno
# PUBLIC_ORIGIN must be set to the ingress HTTPS origin at runtime.
USER ytdlp:ytdlp
WORKDIR /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python3 -c 'import urllib.request; urllib.request.urlopen("http://127.0.0.1:3000/healthz", timeout=3).close()' || exit 1
ENTRYPOINT ["/usr/local/bin/yt-dlp-web"]
