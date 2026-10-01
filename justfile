image := 'yt-dlp-web:local'
engine := 'docker'
build_flags := ''
platform_flags := '--platform linux/amd64'

dev:
    NODE_ENV=development bun --watch app/index.ts

build:
    bun scripts/build.ts

start: build
    ./dist/yt-dlp-web

reset-db:
    bun app/index.ts --reset-db

check:
    biome check .

format:
    biome check --write .

typecheck:
    ./node_modules/.bin/tsc --noEmit -p tsconfig.json

test:
    bun test tests/

test-client: _browser
    node_modules/.bin/playwright test

_browser:
    node_modules/.bin/playwright install chromium

build-image:
    {{engine}} build {{build_flags}} {{platform_flags}} -t {{image}} .

smoke-image: build-image
    {{engine}} run --rm {{platform_flags}} --entrypoint sh {{image}} -c \
        'yt-dlp --version && python3 -c "import yt_dlp, yt_dlp_ejs" && deno --version && ffmpeg -version'

# Requires a private HTTPS ingress forwarding this origin to localhost:3000.
run-image origin:
    {{engine}} run --rm {{platform_flags}} -p 127.0.0.1:3000:3000 \
        -e PUBLIC_ORIGIN='{{origin}}' \
        --mount type=volume,source=yt-dlp-web-data,target=/data {{image}}

clean:
  rm -rf ./dist/
