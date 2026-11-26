# syntax=docker.io/docker/dockerfile:1.29.0@sha256:572cebbc2b15e6f84c077742952674889cb63cd5e9b80abdffcbe587b6f19183

FROM docker.io/oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS builder
WORKDIR /src
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile --production
COPY tsconfig.json ./
COPY app/ app/
COPY scripts/build.ts scripts/build.ts
RUN bun scripts/build.ts

FROM ghcr.io/acidghost/yt-dlp-oci:2026.10.26-0@sha256:3f27a361ecb7810239701b6aa18701179690148601e5fe83636c49d781f01dbb
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
