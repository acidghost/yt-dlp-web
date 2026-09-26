import { existsSync, readdirSync, rmSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { BunRequest } from "bun";
import { packageHls as createHls, type PackageHls } from "./hls";
import page from "./index.html";
import { hlsComplete, Library, validVideoId } from "./library";
import {
  canonicalVideoUrl,
  type Download,
  downloadVideo,
  type ExtractHls,
  extractHls as extractYouTubeHls,
  InputError,
} from "./media";
import type { ResolvedVideo } from "./protocol";
import { ProxySession, type UpstreamFetch } from "./proxy";

const json = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
    },
  });

// Owns the whole "small JSON POST body" contract: content type, size cap
// while streaming (chunked-safe), and parsing. Returns either the parsed
// value for the handler or a ready-made 415/400 response.
type JsonBody = { value: unknown } | { response: Response };

async function jsonBody(request: Request): Promise<JsonBody> {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    return { response: json({ error: "Expected application/json." }, 415) };
  if (Number(request.headers.get("content-length")) > 2048)
    return { response: json({ error: "Request is too large." }, 400) };
  const reader = request.body?.getReader();
  if (!reader) return { response: json({ error: "Expected JSON body." }, 400) };
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2048)
        return { response: json({ error: "Request is too large." }, 400) };
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return {
      value: JSON.parse(
        new TextDecoder().decode(Bun.concatArrayBuffers(chunks)),
      ),
    };
  } catch {
    return { response: json({ error: "Expected JSON body." }, 400) };
  }
}

// A bare http(s) origin without credentials, path, query, or default port.
function normalizePublicOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      "PUBLIC_ORIGIN must be a valid origin like https://player.example.com",
    );
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "PUBLIC_ORIGIN must be a bare origin like https://player.example.com",
    );
  }
  return `${url.protocol}//${url.host}`.toLowerCase();
}

// End is inclusive. null means no/invalid range, or unsatisfiable if requested.
function byteRange(header: string, size: number): [number, number] | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || size === 0) return null;
  const start = match[1]
    ? Number(match[1])
    : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start >= size ||
    end < start
  )
    return null;
  return [start, Math.min(end, size - 1)];
}

export function startServer({
  port = 3000,
  hostname = process.env.HOST ?? "127.0.0.1",
  publicOrigin = process.env.PUBLIC_ORIGIN ?? null,
  dataDir = process.env.DATA_DIR ?? "./data",
  sessionTtlMs = 6 * 60 * 60 * 1000,
  download = downloadVideo,
  packageHls = createHls,
  extractHls = extractYouTubeHls,
  upstreamFetch = fetch,
}: {
  port?: number;
  hostname?: string;
  publicOrigin?: string | null;
  dataDir?: string;
  sessionTtlMs?: number;
  download?: Download;
  packageHls?: PackageHls;
  extractHls?: ExtractHls;
  upstreamFetch?: UpstreamFetch;
} = {}) {
  const proxies = new Map<string, ProxySession>();
  const preparing = new Map<
    string,
    Promise<{
      title: string;
      duration: number | null;
      channel: string | null;
      hls: boolean;
    }>
  >();
  const resolved = new Map<
    string,
    ResolvedVideo & { kind: "proxy" | "download" }
  >();
  // Registers a resolved video's watch token and returns it as JSON.
  const publish = (
    video: ResolvedVideo,
    kind: "proxy" | "download",
  ): Response => {
    resolved.set(video.token, { ...video, kind });
    return json(video);
  };
  const library = new Library(dataDir);
  const mediaRoot = join(dataDir, "media");

  // Only clean our own unfinished staging directories, not the PoC's tmp/ UUID files.
  if (existsSync(mediaRoot)) {
    for (const entry of readdirSync(mediaRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !validVideoId(entry.name)) continue;
      for (const name of readdirSync(join(mediaRoot, entry.name))) {
        if (/^\.staging-[0-9a-f-]{36}$/.test(name))
          rmSync(join(mediaRoot, entry.name, name), {
            recursive: true,
            force: true,
          });
      }
    }
  }

  if (typeof hostname !== "string" || hostname.trim() === "")
    throw new Error("HOST must be a nonempty hostname or address.");

  if (!Number.isSafeInteger(sessionTtlMs) || sessionTtlMs <= 0)
    throw new Error("The proxy session TTL must be a positive integer.");

  // A bare http(s) origin, normalized: default ports dropped, no path or creds.
  const configuredOrigin =
    publicOrigin === null || publicOrigin === undefined
      ? null
      : normalizePublicOrigin(publicOrigin);

  const loopbackBind =
    hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";

  if (!loopbackBind && !configuredOrigin)
    throw new Error(
      "Binding HOST outside loopback requires PUBLIC_ORIGIN, e.g. https://player.example.com",
    );

  const deleting = new Set<string>();
  let activeDownloads = 0;
  let activeExtractions = 0;

  // Allowed same-origin values: the configured ingress origin, or loopback names.
  const allowedOrigins = (): string[] =>
    configuredOrigin
      ? [configuredOrigin]
      : [`http://127.0.0.1:${server.port}`, `http://localhost:${server.port}`];

  // Route wrappers: the guards live in the route table, so handlers contain
  // only business logic. Only /healthz and the static page skip them.
  // Host checking on every route blocks DNS rebinding; Origin (when browsers
  // send it) must match on reads and mutations alike.
  type RouteHandler<Path extends string> = (
    request: BunRequest<Path>,
  ) => Response | Promise<Response>;
  const readRoute =
    <Path extends string>(handler: RouteHandler<Path>): RouteHandler<Path> =>
    (request) => {
      const origins = allowedOrigins();
      const host = request.headers.get("host")?.toLowerCase() ?? "";
      const origin = request.headers.get("origin");
      const provenanceOk =
        origins.some((candidate) => new URL(candidate).host === host) &&
        (origin === null || origins.includes(origin.toLowerCase()));
      return provenanceOk
        ? handler(request)
        : json({ error: "Invalid origin." }, 403);
    };
  // Mutations add a same-origin Fetch-Metadata requirement on top of the read
  // guard, which covers no-Origin browser form attempts. CORS stays disabled.
  const mutationRoute = <Path extends string>(
    handler: RouteHandler<Path>,
  ): RouteHandler<Path> =>
    readRoute((request) => {
      const site = request.headers.get("sec-fetch-site");
      return site !== null && site.toLowerCase() !== "same-origin"
        ? json({ error: "Invalid origin." }, 403)
        : handler(request);
    });
  const sweepExpiredProxies = (): void => {
    for (const [token, proxy] of proxies)
      if (Date.now() - proxy.createdAt > sessionTtlMs) proxies.delete(token);
  };

  async function resolveVideo(body: unknown) {
    try {
      const parsed = body as { url?: unknown; mode?: unknown };
      const videoUrl = canonicalVideoUrl(parsed?.url);
      const id = videoUrl.slice(-11);
      if (parsed.mode === "proxy") {
        sweepExpiredProxies();
        if (proxies.size >= 16 || activeExtractions >= 2)
          return json(
            { error: "Too many HLS sessions. Retry or restart the server." },
            429,
          );

        activeExtractions++;
        try {
          const source = await extractHls(videoUrl);
          const token = crypto.randomUUID();
          const proxy = new ProxySession(source, upstreamFetch);
          await proxy.prepare(token);
          proxies.set(token, proxy);

          return publish(
            {
              id,
              url: videoUrl,
              token,
              title: source.title,
              channel: source.channel,
              duration: source.duration,
              hls: `/api/proxy/${token}/0`,
            },
            "proxy",
          );
        } finally {
          activeExtractions--;
        }
      }

      if (parsed.mode !== undefined && parsed.mode !== "download")
        throw new InputError("Unknown playback mode.");
      if (deleting.has(id))
        return json({ error: "Video is being deleted. Retry later." }, 409);

      let task = preparing.get(id);
      if (!task) {
        if (activeDownloads >= 2)
          return json({ error: "Two downloads are already in progress." }, 429);

        activeDownloads++;
        task = prepareDownload(id, videoUrl);
        preparing.set(id, task);
        void task
          .finally(() => {
            preparing.delete(id);
            activeDownloads--;
          })
          .catch(() => {}); // The waiting requests report the preparation error.
      }

      const video = await task;

      return publish(
        {
          id,
          url: videoUrl,
          token: crypto.randomUUID(),
          title: video.title,
          channel: video.channel,
          duration: video.duration,
          stream: `/api/stream/${id}`,
          ...(video.hls ? { hls: `/api/hls/${id}/index.m3u8` } : {}),
        },
        "download",
      );
    } catch (error) {
      return json(
        {
          error:
            error instanceof InputError
              ? error.message
              : "Could not prepare video.",
        },
        error instanceof InputError ? 400 : 502,
      );
    }
  }

  async function prepareDownload(id: string, url: string) {
    const dir = join(mediaRoot, id);
    const mp4 = join(dir, "video.mp4");
    const hlsDir = join(dir, "hls");
    const stage = join(dir, `.staging-${crypto.randomUUID()}`);
    await mkdir(stage, { recursive: true });
    try {
      let video = library.metadata(id);
      const file = Bun.file(mp4);

      // Download to staging on the same volume, validate, then publish.
      if (!(await file.exists()) || file.size === 0) {
        const stagedMp4 = join(stage, "video.mp4");
        const downloaded = await download(url, stagedMp4);
        const staged = Bun.file(stagedMp4);
        if (!(await staged.exists()) || staged.size === 0)
          throw new InputError("yt-dlp did not create a nonempty MP4 file.");

        await rename(stagedMp4, mp4);
        video = downloaded;
        library.remember(id, downloaded);
      }
      if (!video)
        video = { title: "Untitled video", duration: null, channel: null };

      // Package HLS in staging; publish only a complete playlist.
      let hls = await hlsComplete(hlsDir);
      if (!hls) {
        try {
          const stagedHls = join(stage, "hls");
          await packageHls(mp4, stagedHls);
          if (!(await hlsComplete(stagedHls)))
            throw new InputError(
              "ffmpeg did not create a complete HLS playlist.",
            );

          await rm(hlsDir, { recursive: true, force: true });
          await rename(stagedHls, hlsDir);
          hls = true;
        } catch {
          // A failed HLS package must not make the published MP4 unplayable.
        }
      }

      return { ...video, hls };
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }

  async function history() {
    return json(await library.list(dataDir));
  }

  async function watched(id: string, body: unknown) {
    if (!validVideoId(id)) return json({ error: "Not found." }, 404);
    const parsed = body as { token?: unknown };
    const video =
      typeof parsed?.token === "string" ? resolved.get(parsed.token) : null;
    if (!video || video.id !== id)
      return json({ error: "Unknown playback session. Play again." }, 404);

    library.watch(video.id, video);
    return json({ ok: true });
  }

  async function serveMp4(
    id: string,
    method: string,
    rangeHeader: string | null,
  ) {
    if (!validVideoId(id)) return json({ error: "Not found." }, 404);
    const file = Bun.file(join(mediaRoot, id, "video.mp4"));
    if (!(await file.exists()) || file.size === 0)
      return json({ error: "File missing. Download again." }, 404);
    const size = file.size;
    const range = rangeHeader === null ? null : byteRange(rangeHeader, size);
    const headers = new Headers({
      "Content-Type": "video/mp4",
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    if (rangeHeader !== null && !range) {
      headers.set("Content-Range", `bytes */${size}`);
      return new Response(null, { status: 416, headers });
    }
    if (range) {
      const [start, end] = range;
      headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
      headers.set("Content-Length", String(end - start + 1));
      return new Response(
        method === "HEAD" ? null : file.slice(start, end + 1),
        {
          status: 206,
          headers,
        },
      );
    }
    headers.set("Content-Length", String(size));
    return new Response(method === "HEAD" ? null : file, { headers });
  }

  async function serveHls(id: string, name: string) {
    if (
      !validVideoId(id) ||
      (name !== "index.m3u8" && !/^\d+\.ts$/.test(name))
    ) {
      return json({ error: "Not found." }, 404);
    }
    const dir = join(mediaRoot, id, "hls");
    if (name === "index.m3u8" && !(await hlsComplete(dir)))
      return json({ error: "Not found." }, 404);
    const file = Bun.file(join(dir, name));
    if (!(await file.exists())) return json({ error: "Not found." }, 404);
    return new Response(file, {
      headers: {
        "Content-Type": name.endsWith(".m3u8")
          ? "application/vnd.apple.mpegurl"
          : "video/mp2t",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  async function deleteHistory(id: string, filesOnly: boolean) {
    if (!validVideoId(id)) return json({ error: "Not found." }, 404);
    if (preparing.has(id) || deleting.has(id))
      return json({ error: "Video is busy. Retry later." }, 409);
    deleting.add(id);
    try {
      await rm(join(mediaRoot, id), { recursive: true, force: true });
      if (!filesOnly) library.delete(id);
      for (const [token, video] of resolved) {
        if (video.id === id && (!filesOnly || video.kind === "download")) {
          resolved.delete(token);
          if (video.kind === "proxy") proxies.delete(token);
        }
      }
      return json({ ok: true });
    } finally {
      deleting.delete(id);
    }
  }

  async function serveProxy(
    range: string | null,
    token: string,
    resource: string,
  ) {
    if (range && (range.length > 64 || !/^bytes=\d*-\d*$/.test(range)))
      return json({ error: "Invalid range." }, 416);
    const proxy = proxies.get(token);
    if (!proxy)
      return json({ error: "Unknown HLS session. Press Play again." }, 404);
    if (Date.now() - proxy.createdAt > sessionTtlMs) {
      proxies.delete(token);
      return json(
        {
          error:
            "This HLS session expired. Press Play again to re-extract the video.",
        },
        404,
      );
    }
    return proxy.serve(token, resource, range ?? undefined);
  }

  const server = Bun.serve({
    hostname,
    port,
    idleTimeout: 0,
    routes: {
      // The imported HTMLBundle only works as a direct route value; the static
      // shell is unguarded, but every API route checks Host/Origin, which makes
      // rebinding the page harmless.
      "/": page,
      "/healthz": { GET: json({ ok: true }) },
      "/api/resolve": {
        POST: mutationRoute(async (request) => {
          const body = await jsonBody(request);
          return "response" in body ? body.response : resolveVideo(body.value);
        }),
      },
      "/api/history": { GET: readRoute(history) },
      // Param routes inline the params so TypeScript infers each handler's
      // BunRequest<route> and typed params, then dispatch to plain arguments.
      "/api/history/:id/watched": {
        POST: mutationRoute(async (request) => {
          const body = await jsonBody(request);
          return "response" in body
            ? body.response
            : watched(request.params.id, body.value);
        }),
      },
      "/api/history/:id/files": {
        DELETE: mutationRoute((request) =>
          deleteHistory(request.params.id, true),
        ),
      },
      "/api/history/:id": {
        DELETE: mutationRoute((request) =>
          deleteHistory(request.params.id, false),
        ),
      },
      "/api/stream/:id": {
        GET: readRoute((request) =>
          serveMp4(
            request.params.id,
            request.method,
            request.headers.get("range"),
          ),
        ),
        HEAD: readRoute((request) =>
          serveMp4(
            request.params.id,
            request.method,
            request.headers.get("range"),
          ),
        ),
      },
      "/api/hls/:id/:file": {
        GET: readRoute((request) =>
          serveHls(request.params.id, request.params.file),
        ),
      },
      "/api/proxy/:token/:resource": {
        GET: readRoute((request) =>
          serveProxy(
            request.headers.get("range"),
            request.params.token,
            request.params.resource,
          ),
        ),
      },
    },
    fetch() {
      return json({ error: "Not found." }, 404);
    },
  });
  return server;
}
