import { existsSync, readdirSync, rmSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { BunRequest } from "bun";
import page from "./index.html";
import { Library, validVideoId } from "./library";
import {
  canonicalVideoUrl,
  type Download,
  type DownloadedVideo,
  downloadVideo,
  type ExtractHls,
  extractHls as extractYouTubeHls,
  InputError,
} from "./media";
import {
  type ApiError,
  type ApiResponse,
  type OkResponse,
  type ProgressRequest,
  ProgressRequestSchema,
  type ResolvedVideo,
  type ResolveRequest,
  ResolveRequestSchema,
  type WatchRequest,
  WatchRequestSchema,
} from "./protocol";
import { ProxySession, type UpstreamFetch } from "./proxy";

const json = (value: ApiResponse, status = 200) =>
  Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
    },
  });

const jsonError = (error: string, status = 500) =>
  json({ error } satisfies ApiError, status);

const jsonOK = () => json({ ok: true } satisfies OkResponse);

const notFound = () => jsonError("Not found.", 404);

// Owns the whole "small JSON POST body" contract: content type, size cap
// while streaming (chunked-safe), and parsing. Returns either the parsed
// value for the handler or a ready-made 415/400 response.
type JsonBody = { value: unknown } | { response: Response };

async function jsonBody(request: Request): Promise<JsonBody> {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    return { response: jsonError("Expected application/json.", 415) };
  if (Number(request.headers.get("content-length")) > 2048)
    return { response: jsonError("Request is too large.", 400) };
  const reader = request.body?.getReader();
  if (!reader) return { response: jsonError("Expected JSON body.", 400) };
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2048)
        return { response: jsonError("Request is too large.", 400) };
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
    return { response: jsonError("Expected JSON body.", 400) };
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
  extractHls = extractYouTubeHls,
  upstreamFetch = fetch,
}: {
  port?: number;
  hostname?: string;
  publicOrigin?: string | null;
  dataDir?: string;
  sessionTtlMs?: number;
  download?: Download;
  extractHls?: ExtractHls;
  upstreamFetch?: UpstreamFetch;
} = {}) {
  const proxies = new Map<string, ProxySession>();
  const preparing = new Map<string, Promise<DownloadedVideo>>();
  const resolved = new Map<string, ResolvedVideo>();
  // Registers a resolved video's watch token and returns it as JSON.
  const publish = (video: ResolvedVideo): Response => {
    resolved.set(video.token, video);
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

  function startPreparation(id: string, url: string) {
    if (activeDownloads >= 2) return null;
    activeDownloads++;
    const preparation = prepareDownload(id, url);
    preparing.set(id, preparation);
    void preparation
      .finally(() => {
        if (preparing.get(id) === preparation) preparing.delete(id);
        activeDownloads--;
      })
      .catch(() => {}); // The waiting requests report the preparation error.
    return preparation;
  }

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
        : jsonError("Invalid origin.", 403);
    };
  // Mutations add a same-origin Fetch-Metadata requirement on top of the read
  // guard, which covers no-Origin browser form attempts. CORS stays disabled.
  const mutationRoute = <Path extends string>(
    handler: RouteHandler<Path>,
  ): RouteHandler<Path> =>
    readRoute((request) => {
      const site = request.headers.get("sec-fetch-site");
      return site !== null && site.toLowerCase() !== "same-origin"
        ? jsonError("Invalid origin.", 403)
        : handler(request);
    });
  const sweepExpiredProxies = (): void => {
    for (const [token, proxy] of proxies)
      if (Date.now() - proxy.createdAt > sessionTtlMs) proxies.delete(token);
  };

  async function resolveVideo(body: ResolveRequest) {
    try {
      const videoUrl = canonicalVideoUrl(body.url);
      const id = videoUrl.slice(-11);
      if (body.mode === "proxy") {
        sweepExpiredProxies();
        if (proxies.size >= 16 || activeExtractions >= 2)
          return jsonError(
            "Too many HLS sessions. Retry or restart the server.",
            429,
          );

        activeExtractions++;
        try {
          const source = await extractHls(videoUrl);
          const token = crypto.randomUUID();
          const proxy = new ProxySession(source, upstreamFetch);
          await proxy.prepare(token);
          proxies.set(token, proxy);

          return publish({
            kind: "proxy",
            id,
            url: videoUrl,
            token,
            title: source.title,
            channel: source.channel,
            duration: source.duration,
            positionSeconds: library.position(id),
            hls: `/api/proxy/${token}/0`,
          });
        } finally {
          activeExtractions--;
        }
      }

      if (deleting.has(id))
        return jsonError("Video is being deleted. Retry later.", 409);

      const preparation = preparing.get(id) ?? startPreparation(id, videoUrl);
      if (!preparation)
        return jsonError("Two downloads are already in progress.", 429);

      const video = await preparation;

      return publish({
        kind: "download",
        id,
        url: videoUrl,
        token: crypto.randomUUID(),
        title: video.title,
        channel: video.channel,
        duration: video.duration,
        positionSeconds: library.position(id),
        stream: `/api/stream/${id}`,
      });
    } catch (error) {
      return jsonError(
        error instanceof InputError
          ? error.message
          : "Could not prepare video.",
        error instanceof InputError ? 400 : 502,
      );
    }
  }

  async function prepareDownload(id: string, url: string) {
    const dir = join(mediaRoot, id);
    const mp4 = join(dir, "video.mp4");
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

      return video;
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }

  async function history() {
    return json(await library.list(dataDir));
  }

  async function watched(id: string, body: WatchRequest) {
    if (!validVideoId(id)) return notFound();
    const video = resolved.get(body.token);
    if (!video || video.id !== id)
      return jsonError("Unknown playback session. Play again.", 404);

    library.watch(video.id, video);
    return jsonOK();
  }

  async function progress(id: string, body: ProgressRequest) {
    if (!validVideoId(id)) return notFound();
    const video = resolved.get(body.token);
    if (!video || video.id !== id)
      return jsonError("Unknown playback session. Play again.", 404);

    // Keep the final position so the client can derive watched status.
    library.progress(id, Math.floor(body.positionSeconds));
    return jsonOK();
  }

  async function serveMp4(
    id: string,
    method: string,
    rangeHeader: string | null,
  ) {
    if (!validVideoId(id)) return notFound();
    const file = Bun.file(join(mediaRoot, id, "video.mp4"));
    if (!(await file.exists()) || file.size === 0)
      return jsonError("File missing. Download again.", 404);
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

  async function deleteHistory(id: string, filesOnly: boolean) {
    if (!validVideoId(id)) return notFound();
    if (preparing.has(id) || deleting.has(id))
      return jsonError("Video is busy. Retry later.", 409);
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
      return jsonOK();
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
      return jsonError("Invalid range.", 416);
    const proxy = proxies.get(token);
    if (!proxy) return jsonError("Unknown HLS session. Press Play again.", 404);
    if (Date.now() - proxy.createdAt > sessionTtlMs) {
      proxies.delete(token);
      return jsonError(
        "This HLS session expired. Press Play again to re-extract the video.",
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
      "/healthz": { GET: jsonOK() },
      "/api/resolve": {
        POST: mutationRoute(async (request) => {
          const body = await jsonBody(request);
          if ("response" in body) return body.response;
          const input = ResolveRequestSchema.safeParse(body.value);
          return input.success
            ? resolveVideo(input.data)
            : jsonError("Invalid request.", 400);
        }),
      },
      "/api/history": { GET: readRoute(history) },
      // Param routes inline the params so TypeScript infers each handler's
      // BunRequest<route> and typed params, then dispatch to plain arguments.
      "/api/history/:id/watched": {
        POST: mutationRoute(async (request) => {
          const body = await jsonBody(request);
          if ("response" in body) return body.response;
          const input = WatchRequestSchema.safeParse(body.value);
          return input.success
            ? watched(request.params.id, input.data)
            : jsonError("Invalid request.", 400);
        }),
      },
      "/api/history/:id/progress": {
        PUT: mutationRoute((request) => {
          const id = request.params.id;
          if (!validVideoId(id)) return notFound();
          const video = library.metadata(id);
          if (!video) return notFound();
          if (
            video.duration === null ||
            !Number.isFinite(video.duration) ||
            video.duration <= 0
          )
            return jsonError("Video duration is unavailable.", 400);
          // Mark completion using trusted metadata, without a separate watched flag.
          library.progress(id, video.duration);
          return jsonOK();
        }),
        DELETE: mutationRoute((request) => {
          const id = request.params.id;
          if (!validVideoId(id) || !library.metadata(id)) return notFound();
          library.progress(id, 0);
          return jsonOK();
        }),
        POST: mutationRoute(async (request) => {
          const body = await jsonBody(request);
          if ("response" in body) return body.response;
          const input = ProgressRequestSchema.safeParse(body.value);
          return input.success
            ? progress(request.params.id, input.data)
            : jsonError("Invalid request.", 400);
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
      return notFound();
    },
  });
  return server;
}
