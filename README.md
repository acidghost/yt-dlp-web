# yt-dlp web (proof of concept)

Paste a public YouTube URL. The default **Proxy YouTube HLS** mode uses yt-dlp
to find a YouTube HLS master playlist, then Bun relays its playlists and
requested segments through same-origin, opaque links to hls.js. Playback can
start without downloading the full video or writing media to disk. The server
only accepts signed media links from HTTPS `*.googlevideo.com`; URLs stay
server-side. It selects H.264/AAC variants up to 720p and prefers the original
audio rendition. This mode only works when YouTube supplies a compatible HLS
master with separate audio/video tracks.

**Download + HLS.js** and **Download + Native MP4** are fallbacks: yt-dlp
downloads/merges H.264/AAC into `DATA_DIR/media/<video-id>/video.mp4`, and
ffmpeg packages `DATA_DIR/media/<video-id>/hls/index.m3u8` plus `.ts` segments
without re-encoding. MP4 is playable even if HLS packaging fails; retrying a
download will try packaging again without re-downloading the MP4. Changing modes
prepares the selected source without autoplay. Switching between the two
downloaded players reuses their files; switching to proxy extracts fresh signed
URLs. Bun bundles the Lit light-DOM player, hls.js and missing.css locally from
the imported `app/index.html` route and serves API/media via `Bun.serve` routes.

## Run

Requires `bun`, `yt-dlp`, and `ffmpeg` on `PATH`. Install the locked browser
dependencies with `bun install --frozen-lockfile`. Recent yt-dlp versions also
need `yt-dlp-ejs` and a JavaScript runtime such as Deno for full YouTube
support.

Environment variables: `PORT` (default `3000`), `HOST` (bind address, default
`127.0.0.1`), `PUBLIC_ORIGIN` (e.g. `https://player.example.com`), and
`DATA_DIR` (default `./data`).

```sh
bun install --frozen-lockfile
bun run dev    # watch app/index.ts; open http://127.0.0.1:3000
bun run check && bun run typecheck && bun run test  # port 3000 must be free
bun run build  # native executable with embedded HTML/JS/CSS: dist/yt-dlp-web
bun run start  # build and launch dist/yt-dlp-web
```

Open a bookmarked URL such as
`http://127.0.0.1:3000/?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Dabcdefghijk`
to prepare proxy HLS without autoplay. Add `&mode=hls` or `&mode=mp4` to prepare
a download instead. Replace the example ID with a real public video ID. An
unknown mode is rejected without contacting the server.

Watch history is saved in SQLite at `DATA_DIR/library.sqlite` (default
`./data/library.sqlite`) when the video actually starts playing, not when a URL
is resolved. History Play reuses the downloaded MP4 when available; otherwise it
prepares a fresh proxy session. History shows the original YouTube link, channel
(when yt-dlp supplies it), duration, watch time, and MP4/HLS file sizes. HLS
size includes the playlist and its segments; sizes and availability reflect the
files currently on disk, not cached database values. Older rows may show
“Channel unavailable” until fresh metadata is extracted (for example, on a new
proxy play) or the video is downloaded again. Downloads are staged under
`DATA_DIR/media/<video-id>/` and reused across requests and restarts. Keep the
SQLite database and media directory together when backing up. **Delete files**
removes downloaded media but keeps watched history; **Delete files and history**
removes both. The UI confirms either choice.

The proxy relays all watched bytes through Bun, so it uses local bandwidth even
though it does not save files. YouTube signed URLs expire; press **Prepare
video** again to re-extract when playback returns an expiry error. Proxy
sessions expire on server restart; downloaded media links use stable video IDs.
Old PoC `./tmp/<uuid>.mp4` and HLS files are neither imported nor deleted
automatically. Review and remove them manually when no longer needed; `./tmp` is
git-ignored.

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
a trusted network or VPN. Note: under `bun run dev`, Bun’s own dev-server guard
additionally blocks foreign Host headers for the HTML page itself; the compiled
binary serves it normally. It handles public, non-live single YouTube videos
only; unsupported formats, playlists, accounts, cookies, and YouTube bot checks
are out of scope.
