# <img src="app/logo.svg" width="40" height="32" alt=""> yt-dlp web

Play public YouTube videos in your browser. Stream through a local proxy or save
an MP4, with watch history, resume positions, and shareable timestamp links.

[Quick start](#quick-start) · [Playback](#playback) ·
[History & storage](#history-and-storage) · [Configuration](#configuration) ·
[Deployment](#deployment) · [Development](#development)

> [!IMPORTANT]
>
> **There is no login or authentication.** Use this app only on a trusted
> network or VPN. For remote access, put it behind a private HTTPS ingress;
> request-origin checks are not authentication.

## Quick start

### Requirements

- **Bun and Just**, pinned in [`mise.toml`](mise.toml).
- **`yt-dlp[default]`**, including `yt-dlp-ejs`.
- **ffmpeg and Deno** on `PATH`, along with yt-dlp.

### Start locally

```sh
mise install --locked
bun install --frozen-lockfile
just dev
```

Open **<http://127.0.0.1:3000>**, paste a public YouTube URL, and select
**Prepare video**. Press play when the source is ready.

To build and run the standalone executable instead, use `just start`. Its UI
assets are embedded; yt-dlp, ffmpeg, and Deno are still runtime requirements.

## Playback

### Choose a mode

| Mode                            | How it plays                                                           | Media on disk |
| ------------------------------- | ---------------------------------------------------------------------- | ------------- |
| **Proxy YouTube HLS** (default) | Stream playlists and segments through Bun to hls.js; no full download. | None          |
| **Download + Native MP4**       | Download and merge once, then reuse on later plays.                    | Reusable MP4  |

Both modes select **H.264/AAC up to 720p**. Proxy mode requires a compatible
YouTube HLS master playlist with separate audio/video tracks and prefers the
original audio rendition. If none is available, use **Download + Native MP4**.

The proxy exposes only same-origin, opaque media links. Signed upstream URLs
stay server-side, and only HTTPS `*.googlevideo.com` media links are accepted.
All watched bytes pass through Bun: **proxy playback uses local bandwidth**,
even though it writes no media files.

Changing modes prepares the selected source **without autoplay**. Switching to
proxy extracts fresh signed URLs; switching to MP4 reuses an existing download.

### Download progress and cancellation

While preparing a new MP4, the player shows **current-transfer bytes, speed,
and percentage**. Video and audio download separately, so the numbers reset
when the labeled phase changes. `≈` marks an estimated total; unknown totals
use an indeterminate bar. Sizes use binary units (MiB), speed is MiB/s, and
missing or stale speed is not presented as a current rate. Combining tracks,
other MP4 processing, and saving the file are separate phases, not “100% ready.”

**Cancel download** stops yt-dlp and its ffmpeg children, then removes unfinished
staging files. The UI stays busy until cleanup is confirmed. Completed MP4s,
watch history, and resume positions are not deleted. The brief **Saving MP4**
commit phase cannot be canceled.

- Requests for the same video share one download. **Cancellation is global for
  that video:** canceling in one tab stops preparation in all tabs sharing it,
  but does not stop downloads of other videos.
- If process termination cannot be confirmed, staging and the busy ID/slot are
  retained rather than risking a live writer. Stop those processes before
  restarting the server; the error never claims cleanup succeeded.
- Closing or navigating away from a preparing tab sends a best-effort global
  cancellation. Merely hiding the tab does not cancel. If the request is lost,
  the shared job expires after **five minutes without polling/activity**;
  another tab's polling keeps its lease alive.
- Progress connection failures retry automatically. A failed cancel request
  does **not** mean the process stopped; retry Cancel if needed.
- At most **two downloads** run concurrently. Jobs live in memory; abandoned
  staging is also cleaned on startup. Refresh recovery, background jobs, and
  pause/resume are not supported.

The in-repo client polls status about once a second. For MP4, `POST /api/resolve`
returns either `200 ResolvedVideo` for a saved file or
`202 { kind: "preparing", jobToken }` for a shared preparation. Poll
`GET /api/downloads/:jobToken`; `DELETE` on that URL cancels the shared job.
Terminal status is retained for two minutes (at most 64 terminal jobs), without
affecting saved MP4s. The former synchronous MP4 download API is not retained;
proxy resolves remain unchanged. All job routes retain the existing
Host/Origin checks, cancellation additionally checks Fetch Metadata, and
responses are not cached.

### Player controls

The integrated controls provide play/pause, seeking, mute/volume, playback speed
(**0.25–2×**), and fullscreen.

| Key           | Action                             |
| ------------- | ---------------------------------- |
| `Space` / `K` | Play or pause                      |
| `←` / `→`     | Seek backward / forward 5 seconds  |
| `J` / `L`     | Seek backward / forward 10 seconds |
| `<` / `>`     | Decrease / increase playback speed |
| `F`           | Toggle fullscreen                  |
| `M`           | Toggle mute                        |

Focused form fields and controls handle their own keys. `↑` / `↓` scroll the
page outside focused sliders and menus.

- **Fill page** expands the player width without entering fullscreen.
- Compact players put seek above the buttons; larger players put it inline.
- Controls stay visible during keyboard use or while the speed menu is open.
- Fullscreen includes the controls and speed menu where element fullscreen is
  supported. iOS may use system video controls instead.

### Bookmark and share

**Copy timestamp link** copies an app link at the current playback time and
preserves the mode. If clipboard access is blocked, select and copy the
displayed link manually.

You can also bookmark an app URL to prepare a video **without autoplay**:

```text
http://127.0.0.1:3000/?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Dabcdefghijk
```

Replace `abcdefghijk` with a real public video ID.

| App URL parameter       | Effect                                              |
| ----------------------- | --------------------------------------------------- |
| `url`                   | The URL-encoded YouTube URL to prepare              |
| `mode=mp4`              | Prepare a download instead of the default proxy HLS |
| `t=83`                  | Seek to 1:23, overriding saved watch progress       |
| `t=0`                   | Start from the beginning                            |
| `start=83` or `t=1m23s` | Alternative timestamp formats                       |

Timestamps inside the YouTube URL also work. The **app link's timestamp takes
precedence** over the YouTube URL's timestamp. Invalid timestamps are ignored;
times beyond the duration seek to the end. Without a valid timestamp, normal
resume behavior applies. An unknown mode is rejected without contacting the
server.

### Proxy session limits

- YouTube's signed URLs expire. Press **Prepare video** again if playback
  reports an expiry error.
- Proxy sessions are capped at **16** and expire after **6 hours**, with a “Play
  again” message. Expired sessions are evicted to free capacity without a
  restart.
- Restarting the server invalidates proxy sessions. Downloaded media links use
  stable video IDs and survive restarts.

## History and storage

Watch history is recorded **when playback actually starts**, not when a URL is
resolved. History **Play** uses the downloaded MP4 when available; otherwise it
prepares a fresh proxy session.

### Resume and watched status

Playback position is saved periodically, on pause, and when the page is hidden.
Preparing a video again seeks to that position after metadata loads.

- **Fully watched** means the saved position is within 30 seconds of the end and
  greater than zero. The browser derives this status; it is not stored
  separately. Fully watched videos start from the beginning when prepared again,
  unless an explicit timestamp overrides it.
- **Reset watch progress** clears the position and watched status without
  deleting history or files. For the current video, it also pauses playback and
  returns to the beginning.
- With no saved position, the button becomes **Mark as fully watched**. It sets
  the saved position to the known duration without changing files or the
  watch-history timestamp. It is unavailable when duration is unknown.

### What is saved

| Path                                  | Contents                                             |
| ------------------------------------- | ---------------------------------------------------- |
| `DATA_DIR/library.sqlite`             | Watch history, resume positions, and cached metadata |
| `DATA_DIR/media/<video-id>/video.mp4` | Reusable MP4 downloads                               |

`DATA_DIR` defaults to `./data`. Downloads are staged under the video's media
directory and reused across requests and restarts. Unfinished staged downloads
are cleaned up on startup.

History shows resume times for unfinished videos, the original YouTube link,
channel (when supplied by yt-dlp), duration, watch time, and MP4 file sizes.
Availability and sizes reflect **files currently on disk**, not cached database
values. Older rows may show “Channel unavailable” until fresh metadata is
extracted, for example by a new proxy play or another download.

Old proof-of-concept `./tmp/<uuid>.mp4` files are neither imported nor deleted
automatically. Review and remove them manually when no longer needed; `./tmp` is
git-ignored.

### Delete and back up

Both deletion choices require confirmation in the UI:

| Action                       | Removes                            | Keeps         |
| ---------------------------- | ---------------------------------- | ------------- |
| **Delete files**             | Downloaded media                   | Watch history |
| **Delete files and history** | Downloaded media and watch history | —             |

> [!WARNING] Back up `DATA_DIR/library.sqlite` and `DATA_DIR/media/` together
> while the server is stopped, or use a consistent SQLite backup/snapshot. Do
> not copy a live database independently of its journal and media.

### Reset an incompatible database

Before v1, schema changes may require a reset. If the stored schema differs from
this build's schema, startup fails with a reset instruction. **The app never
changes or deletes the database automatically.**

Stop the server, then run one of these with the **same `DATA_DIR`** as the
server:

```sh
just reset-db         # from the source tree
# or
yt-dlp-web --reset-db  # using the installed executable
```

This removes only `library.sqlite` and its SQLite journal files. It clears watch
history, resume positions, and cached metadata, but **keeps downloaded MP4s**
for reuse.

## Configuration

| Variable        | Default     | Purpose                                                    |
| --------------- | ----------- | ---------------------------------------------------------- |
| `PORT`          | `3000`      | Server port                                                |
| `HOST`          | `127.0.0.1` | Bind address                                               |
| `PUBLIC_ORIGIN` | Unset       | Trusted external origin, e.g. `https://player.example.com` |
| `DATA_DIR`      | `./data`    | SQLite history and downloaded media                        |

Binding outside loopback requires `PUBLIC_ORIGIN`. Use exactly one HTTPS origin
behind a trusted ingress; only its Host/Origin is accepted. The default loopback
configuration accepts `localhost` and `127.0.0.1` as page hostnames.

## Deployment

### Container

The image targets **`linux/amd64`**, runs as **UID/GID 1000**, and needs a
writable volume at **`/data`**.

```sh
just build-image
just smoke-image
just run-image https://player.example.com
```

- `build-image` builds `yt-dlp-web:local` for Linux with embedded UI assets. Do
  **not** copy a macOS `dist/yt-dlp-web` into the image.
- `smoke-image` rebuilds, then checks yt-dlp, yt-dlp-ejs, Deno, and ffmpeg.
- `run-image` creates or reuses the `yt-dlp-web-data` volume and publishes port
  3000 on loopback for a private HTTPS ingress.

The container binds `0.0.0.0:3000`. Set `PUBLIC_ORIGIN` to the external HTTPS
origin; startup fails if it is missing. `DATA_DIR=/data` and
`DENO_DIR=/data/.deno` keep history, media, and Deno's cache on the volume.

> [!NOTE] The example expects ingress traffic from `https://player.example.com`.
> Browsing `http://127.0.0.1:3000` directly with that configuration is rejected
> by the Host guard. For local browsing, use `just dev` with its default
> loopback settings.

The digest-pinned [`yt-dlp-oci`](https://github.com/acidghost/yt-dlp-oci)
runtime base supplies hash-locked yt-dlp/yt-dlp-ejs, Python, and Deno; this
image adds ffmpeg. Both base images are pinned by digest in
[`Dockerfile`](Dockerfile).

Pushing a Git tag publishes a **signed** image to
`ghcr.io/acidghost/yt-dlp-web:<tag>`, with provenance and an SBOM. There is no
floating `latest` tag; **pin deployments to the resulting digest**.

For an arm64 node, build a matching arm64 `yt-dlp-oci` base first. Do not
cross-build this runtime from the amd64-only release.

### Kubernetes

Run behind a **private HTTPS ingress** with a host matching `PUBLIC_ORIGIN`.

| Setting                  | Recommendation                                                                         |
| ------------------------ | -------------------------------------------------------------------------------------- |
| Replicas                 | **1**                                                                                  |
| Persistent storage       | One ReadWriteOnce PVC mounted at `/data`; start with 20Gi                              |
| Architecture             | amd64 nodes: `nodeSelector: { kubernetes.io/arch: amd64 }`                             |
| Security context         | `runAsUser: 1000`, `runAsGroup: 1000`; `fsGroup: 1000` if group write access is needed |
| Origin                   | Set `PUBLIC_ORIGIN` explicitly on the Deployment                                       |
| Liveness / readiness     | `GET /healthz` on port 3000                                                            |
| Termination grace period | **More than 5 seconds**                                                                |

Suggested starting resources; measure actual download and ffmpeg use:

| Resource          | Request | Limit |
| ----------------- | ------- | ----- |
| Memory            | 256Mi   | 1Gi   |
| CPU               | 250m    | 2     |
| Ephemeral storage | 256Mi   | 1Gi   |

**Size and monitor the PVC separately.** Downloads and packaging stage on
`/data`, and there is no app-level media quota. Restrict runtime egress as
needed for YouTube, googlevideo, and the extractor's JavaScript challenges.

On SIGTERM/SIGINT, the server stops accepting requests, aborts active download
process groups, and awaits staging cleanup within a five-second stop budget.
Long-lived media streams are then closed. Restart with the same PVC to retain
history and completed downloads.

### Deployment checklist

After `just smoke-image`, run behind ingress and verify:

- [ ] `/healthz` and the bundled HTML/JS/CSS load.
- [ ] A public, non-live video plays in **both playback modes**.
- [ ] History replays after a restart with the same volume.
- [ ] Both deletion choices work as expected.

## Security and scope

Expose remote deployments **only over a VPN or private HTTPS ingress**, never
publicly. Forward the original `Host` and `Origin` unchanged; do not rely on
`X-Forwarded-Host`.

- **API Host validation** protects against DNS rebinding. `GET /healthz` accepts
  any Host so probes can reach it.
- **Mutations** (`POST` / `PUT` / `DELETE`) check `Origin` and Fetch-Metadata to
  reject cross-site forms and fetches, even without an `Origin` header.
- **CORS is disabled**: no `Access-Control-Allow-Origin` header is emitted.
- Under `just dev`, Bun's own dev-server guard additionally blocks foreign Host
  headers for the HTML page. The compiled binary serves it normally.

The app supports **public, non-live, single YouTube videos only**. Unsupported
formats, playlists, accounts, cookies, and YouTube bot checks are out of scope.

## Development

Bun serves API/media routes via `Bun.serve` and bundles the Lit light-DOM
player, hls.js, and missing.css locally from [`app/index.html`](app/index.html).

| Command                 | Purpose |
| ----------------------- | ------- |
| `just dev`              | Run with watch mode on `app/index.ts` |
| `just check`            | Run Biome checks |
| `just typecheck`        | Run strict TypeScript checks |
| `just test-all`         | All four test suites sequentially, including real tools and Chromium |
| `just test-app`             | Composed Bun integration and focused unit tests; file-isolated external doubles |
| `just test-app-shuffle [seed]` | Ordinary suite in reproducible shuffled order (default 424242) |
| `just test-process`     | Real POSIX process-group termination contract |
| `just test-media-tools` | Opt-in offline yt-dlp/ffmpeg progress, merging, metadata, codecs and cancellation |
| `just test-media-tools-shuffle [seed]` | Offline tools in shuffled order (default 42) |
| `just test-client`      | Chromium real-backend journeys and focused browser integration |
| `just build`            | Build `dist/yt-dlp-web` with embedded HTML/JS/CSS |
| `just start`            | Build and launch the standalone executable |

Ordinary tests use ephemeral ports and need no yt-dlp, ffmpeg or external
network. In a sandbox granting only localhost port 3000, use
`TEST_PORT=3000 just test-app` serially. Keep **port 3000 free** for Playwright.
The browser host owns fresh `tmp/e2e-data`; do not reuse that directory for
another running instance.

`just test-all` includes the real-tools and browser prerequisites below; shuffle
recipes are optional repeat runs, not additional suites.

`just test-media-tools` requires yt-dlp, ffmpeg and ffprobe on `PATH`, but no
network: only source extraction is adapted to local fixture data at the real
process launcher. Production flags, stream policy and metadata parsing stay
real. Local file URLs are never enabled by the application. Missing tools or
unconfirmed termination fail the suite; potentially active files are retained.
Run the OS/tools contracts on macOS and target Linux/container environments.
Sandboxes may restrict signalling; Chromium cannot run in the current nono
sandbox.

See [testing and ownership](docs/testing.md) for suite boundaries, removed-test
replacements, verification gates and resource ownership.
