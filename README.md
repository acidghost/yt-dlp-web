# yt-dlp web

Paste a public YouTube URL. The default **Proxy YouTube HLS** mode uses yt-dlp
to find a YouTube HLS master playlist, then Bun relays its playlists and
requested segments through same-origin, opaque links to hls.js. Playback can
start without downloading the full video or writing media to disk. The server
only accepts signed media links from HTTPS `*.googlevideo.com`; URLs stay
server-side. It selects H.264/AAC variants up to 720p and prefers the original
audio rendition. This mode only works when YouTube supplies a compatible HLS
master with separate audio/video tracks.

**Download + Native MP4** is the fallback: yt-dlp downloads/merges H.264/AAC
into `DATA_DIR/media/<video-id>/video.mp4`. Downloads are reused across plays.
Changing modes prepares the selected source without autoplay; switching to proxy
extracts fresh signed URLs. Bun bundles the Lit light-DOM player, hls.js and
missing.css locally from the imported `app/index.html` route and serves API/media
via `Bun.serve` routes.

## Run

Requires Bun 1.4.2, Just, `yt-dlp[default]` (including `yt-dlp-ejs`), `ffmpeg`,
and Deno on `PATH` (Bun and Just are pinned in `mise.toml`). For a local Python
installation, use the hash-locked requirements from
[`yt-dlp-oci`](https://github.com/acidghost/yt-dlp-oci) with Python 3.14, or
install the matching yt-dlp version (2026.8.19) in a virtual environment. The
container includes these tools. Install the locked browser dependencies with
`bun install --frozen-lockfile`.

Environment variables: `PORT` (default `3000`), `HOST` (bind address, default
`127.0.0.1`), `PUBLIC_ORIGIN` (e.g. `https://player.example.com`), and
`DATA_DIR` (default `./data`).

```sh
bun install --frozen-lockfile
just dev    # watch app/index.ts; open http://127.0.0.1:3000
just check && just typecheck && just test  # port 3000 must be free
just test-client  # port 3000 must be free
just build  # native executable with embedded HTML/JS/CSS: dist/yt-dlp-web
just start  # build and launch dist/yt-dlp-web
```

Open a bookmarked URL such as
`http://127.0.0.1:3000/?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Dabcdefghijk`
to prepare proxy HLS without autoplay. Add `&mode=mp4` to prepare a download
instead. Replace the example ID with a real public video ID. An
unknown mode is rejected without contacting the server.

Watch history is saved in SQLite at `DATA_DIR/library.sqlite` (default
`./data/library.sqlite`) when the video actually starts playing, not when a URL
is resolved. History Play reuses the downloaded MP4 when available; otherwise it
prepares a fresh proxy session. Playback position is saved periodically and on
pause or when the page is hidden. Preparing the video again seeks to that
position after metadata loads; reaching the end clears it. History shows the
resume time when one is saved, along with the original YouTube link, channel
(when yt-dlp supplies it), duration, watch time, and MP4 file sizes. Sizes and
availability reflect the files currently on disk, not cached database values.
Older rows may show “Channel unavailable” until fresh metadata is extracted
(for example, on a new proxy play) or the video is downloaded again. Downloads
are staged under `DATA_DIR/media/<video-id>/` and reused across requests and
restarts. Back up `DATA_DIR/library.sqlite` and `DATA_DIR/media/` together while
the server is stopped (or use a consistent SQLite backup/snapshot); do not copy
a live database file independently of its journal and media. **Delete files** removes
downloaded media but keeps watched history; **Delete files and history** removes
both. The UI confirms either choice.

The proxy relays all watched bytes through Bun, so it uses local bandwidth even
though it does not save files. YouTube signed URLs expire; press **Prepare
video** again to re-extract when playback returns an expiry error. Proxy
sessions expire on server restart; downloaded media links use stable video IDs.
Old PoC `./tmp/<uuid>.mp4` files are neither imported nor deleted
automatically. Review and remove them manually when no longer needed; `./tmp` is
git-ignored.

## Container deployment

Build for `linux/amd64` (the published `yt-dlp-oci` image supports that
architecture). The builder compiles a Linux Bun binary with embedded UI assets;
the digest-pinned [`yt-dlp-oci`](https://github.com/acidghost/yt-dlp-oci) base
supplies hash-locked `yt-dlp[default]`/`yt-dlp-ejs`, Python and Deno. This image
adds ffmpeg. Do **not** copy a macOS `dist/yt-dlp-web` into the container. It
runs as UID/GID 1000 and requires a writable volume at `/data`. It binds
`0.0.0.0:3000` and **requires** `PUBLIC_ORIGIN` to be the one external HTTPS
origin; it deliberately fails at startup if this is missing. `DATA_DIR=/data`
and `DENO_DIR=/data/.deno` keep history, media and Deno's cache on the volume.

```sh
just build-image   # linux/amd64 image: yt-dlp-web:local
just smoke-image   # rebuild, then check yt-dlp, yt-dlp-ejs, Deno, ffmpeg
just run-image https://player.example.com  # creates/reuses yt-dlp-web-data volume
```

Pushing a Git tag publishes a signed `linux/amd64` image to
`ghcr.io/acidghost/yt-dlp-web:<tag>` with provenance and an SBOM. No floating
`latest` tag is published; pin deployments to the resulting digest.

For an arm64 node, build a matching arm64 `yt-dlp-oci` base first; do not
cross-build this runtime from the amd64-only release. Both base images are
pinned by digest in `Dockerfile`. Put a trusted HTTPS reverse proxy in front of
the container and expose it **only** over a VPN or private ingress, not
publicly; there is no login/authentication. Forward the original `Host` and
`Origin` unchanged (do not rely on `X-Forwarded-Host`). The loopback-published
example needs an ingress forwarding requests from `https://player.example.com`;
browsing `http://127.0.0.1:3000` directly with that configuration will be
rejected by the Host guard. For local browsing, use `just dev` with the default
loopback settings instead.

In Kubernetes, run **one replica** with one ReadWriteOnce PVC mounted at `/data`
(e.g. 20Gi to start); set `PUBLIC_ORIGIN` explicitly on the Deployment and use a
private HTTPS ingress with a matching host. Schedule it on amd64 nodes (e.g.
`nodeSelector: { kubernetes.io/arch: amd64 }`). Set `runAsUser: 1000`,
`runAsGroup: 1000`, and `fsGroup: 1000` if the volume needs group write access.
Probe `GET /healthz` on port 3000 for liveness/readiness. For example, start
with memory request/limit 256Mi/1Gi, CPU request/limit 250m/2, and
`ephemeral-storage` request/limit 256Mi/1Gi, then measure actual download and
ffmpeg use. Downloads and packaging stage on `/data`, so **size and monitor the
PVC separately**; there is no app-level media quota. Restrict runtime egress as
needed for YouTube, googlevideo, and the extractor's JS challenges. On
SIGTERM/SIGINT the server stops accepting requests and allows up to five seconds
for active requests before closing media streams; keep the Kubernetes
termination grace period above five seconds. Unfinished staged downloads are
cleaned up on restart. Restart with the same PVC to retain history and
downloads. Review old PoC `tmp/` UUID files manually before removing them; the
app never imports or deletes them.

After `just smoke-image`, run the container behind ingress and check `/healthz`
and the bundled HTML/JS/CSS. Play a public non-live video in all three modes;
restart with the same volume, replay history, and check both deletion choices.

By default the server binds to loopback and accepts `localhost` or `127.0.0.1`
as the page hostname. Setting `HOST=0.0.0.0` (or any non-loopback address)
requires `PUBLIC_ORIGIN`: exactly one HTTPS origin behind a trusted ingress, and
only that Host/Origin is then accepted. Every route checks the Host header
(DNS-rebind protection); mutations (`POST`/`DELETE`) additionally require a
matching `Origin` and same-origin Fetch-Metadata, so cross-site forms and
fetches are rejected even without an `Origin` header. CORS stays disabled — no
`Access-Control-Allow-Origin` is ever emitted. `GET /healthz` answers probes
from any Host. Proxy HLS sessions are capped at 16 and expire after 6 hours with
a “Play again” message; expired sessions are evicted so capacity frees up
without a restart. Origin checks are not authentication: only expose this behind
a trusted network or VPN. Note: under `just dev`, Bun’s own dev-server guard
additionally blocks foreign Host headers for the HTML page itself; the compiled
binary serves it normally. It handles public, non-live single YouTube videos
only; unsupported formats, playlists, accounts, cookies, and YouTube bot checks
are out of scope.
