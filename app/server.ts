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
  DownloadTerminationError,
  downloadVideo,
  type ExtractHls,
  extractHls as extractYouTubeHls,
  InputError,
} from "./media";
import {
  type ApiError,
  type ApiResponse,
  type OkResponse,
  type PreparationSnapshot,
  type ProgressRequest,
  ProgressRequestSchema,
  type ResolvedVideo,
  type ResolveRequest,
  ResolveRequestSchema,
  TransferProgressSchema,
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

const jsonError = (error: string, status = 500) => json({ error } satisfies ApiError, status);

const jsonOK = () => json({ ok: true } satisfies OkResponse);

const notFound = () => jsonError("Not found.", 404);

// Owns the whole "small JSON POST body" contract: content type, size cap
// while streaming (chunked-safe), and parsing. Returns either the parsed
// value for the handler or a ready-made 415/400 response.
type JsonBody = { value: unknown } | { response: Response };

async function jsonBody(request: Request): Promise<JsonBody> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) {
    return { response: jsonError("Expected application/json.", 415) };
  }
  if (Number(request.headers.get("content-length")) > 2048) {
    return { response: jsonError("Request is too large.", 400) };
  }

  const reader = request.body?.getReader();
  if (!reader) {
    return { response: jsonError("Expected JSON body.", 400) };
  }

  let size = 0;
  const chunks: Uint8Array[] = [];

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      size += value.byteLength;
      if (size > 2048) {
        return { response: jsonError("Request is too large.", 400) };
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  try {
    return {
      value: JSON.parse(new TextDecoder().decode(Bun.concatArrayBuffers(chunks))),
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
    throw new Error("PUBLIC_ORIGIN must be a valid origin like https://player.example.com");
  }

  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("PUBLIC_ORIGIN must be a bare origin like https://player.example.com");
  }

  return `${url.protocol}//${url.host}`.toLowerCase();
}

// End is inclusive. null means no/invalid range, or unsatisfiable if requested.
function byteRange(header: string, size: number): [number, number] | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || size === 0) {
    return null;
  }

  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) {
    return null;
  }

  return [start, Math.min(end, size - 1)];
}

export function startServer({
  port = 3000,
  hostname = "127.0.0.1",
  publicOrigin = null,
  dataDir = "./data",
  sessionTtlMs = 6 * 60 * 60 * 1000,
  downloadLeaseMs = 5 * 60_000,
  downloadRetentionMs = 2 * 60_000,
  download = downloadVideo,
  extractHls = extractYouTubeHls,
  upstreamFetch = fetch,
  now = Date.now,
}: {
  port?: number;
  hostname?: string;
  publicOrigin?: string | null;
  dataDir?: string;
  sessionTtlMs?: number;
  downloadLeaseMs?: number;
  downloadRetentionMs?: number;
  download?: Download;
  extractHls?: ExtractHls;
  upstreamFetch?: UpstreamFetch;
  now?: () => number;
} = {}) {
  const proxies = new Map<string, ProxySession>();

  type DownloadJob = {
    token: string;
    controller: AbortController;
    snapshot: PreparationSnapshot;
    lastActivity: number;
    updatedAt: number;
    endedAt: number | null;
    unsafe: boolean;
    done: Promise<void>;
  };

  const preparing = new Map<string, DownloadJob>();
  const jobs = new Map<string, DownloadJob>();
  const resolved = new Map<string, ResolvedVideo>();

  // Registers a resolved video's watch token and returns it as JSON.
  const publish = (video: ResolvedVideo): Response => {
    resolved.set(video.token, video);

    return json(video);
  };

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("The server port must be an integer between 0 and 65535.");
  }

  if (typeof hostname !== "string" || hostname.trim() === "") {
    throw new Error("HOST must be a nonempty hostname or address.");
  }

  if (!Number.isSafeInteger(sessionTtlMs) || sessionTtlMs <= 0) {
    throw new Error("The proxy session TTL must be a positive integer.");
  }

  for (const ms of [downloadLeaseMs, downloadRetentionMs]) {
    if (!Number.isSafeInteger(ms) || ms <= 0) {
      throw new Error("Download lease and retention must be positive integers.");
    }
  }

  // A bare http(s) origin, normalized: default ports dropped, no path or creds.
  const configuredOrigin =
    publicOrigin === null || publicOrigin === undefined
      ? null
      : normalizePublicOrigin(publicOrigin);

  const loopbackBind = hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";

  if (!loopbackBind && !configuredOrigin) {
    throw new Error(
      "Binding HOST outside loopback requires PUBLIC_ORIGIN, e.g. https://player.example.com",
    );
  }

  const library = new Library(dataDir, now);
  const mediaRoot = join(dataDir, "media");
  let sweepTimer: ReturnType<typeof setInterval> | undefined;

  try {
    // Only clean our own unfinished staging directories, not the PoC's tmp/ UUID files.
    if (existsSync(mediaRoot)) {
      for (const entry of readdirSync(mediaRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !validVideoId(entry.name)) {
          continue;
        }

        for (const name of readdirSync(join(mediaRoot, entry.name))) {
          if (/^\.staging-[0-9a-f-]{36}$/.test(name)) {
            rmSync(join(mediaRoot, entry.name, name), {
              recursive: true,
              force: true,
            });
          }
        }
      }
    }

    const deleting = new Set<string>();
    let activeDownloads = 0;
    let activeExtractions = 0;
    let shuttingDown = false;

    function downloadResult(id: string, url: string, video: DownloadedVideo): ResolvedVideo {
      const result: ResolvedVideo = {
        kind: "download",
        id,
        url,
        token: crypto.randomUUID(),
        ...video,
        positionSeconds: library.position(id),
        stream: `/api/stream/${id}`,
      };

      resolved.set(result.token, result);

      return result;
    }

    function cancelJob(job: DownloadJob): void {
      if (job.snapshot.state !== "preparing" || job.snapshot.phase === "finalizing") {
        return;
      }

      job.snapshot = { state: "canceling" };
      job.controller.abort();
    }

    function sweepDownloads(): void {
      const currentTime = now();

      for (const [token, job] of jobs) {
        if (job.endedAt !== null && currentTime - job.endedAt >= downloadRetentionMs) {
          jobs.delete(token);
        } else if (job.endedAt === null && currentTime - job.lastActivity >= downloadLeaseMs) {
          cancelJob(job);
        }
      }

      const terminal = [...jobs.values()].filter((job) => job.endedAt !== null);

      terminal.sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));

      for (const job of terminal.slice(0, Math.max(0, terminal.length - 64))) {
        jobs.delete(job.token);
      }
    }

    function startPreparation(id: string, url: string): DownloadJob | null {
      if (activeDownloads >= 2) {
        return null;
      }

      activeDownloads++;

      const job: DownloadJob = {
        token: crypto.randomUUID(),
        controller: new AbortController(),
        snapshot: {
          state: "preparing",
          phase: "checking",
          downloadedBytes: null,
          totalBytes: null,
          totalEstimated: false,
          speedBytesPerSecond: null,
        },
        lastActivity: now(),
        updatedAt: now(),
        endedAt: null,
        unsafe: false,
        done: Promise.resolve(),
      };

      preparing.set(id, job);
      jobs.set(job.token, job);
      job.done = prepareDownload(id, url, job)
        .then(
          (video) => {
            job.snapshot = {
              state: "ready",
              video: downloadResult(id, url, video),
            };
          },
          (error) => {
            job.unsafe = error instanceof DownloadTerminationError;
            job.snapshot =
              job.controller.signal.aborted && error instanceof Error && error.name === "AbortError"
                ? { state: "canceled" }
                : {
                    state: "error",
                    error: error instanceof InputError ? error.message : "Could not prepare video.",
                  };
          },
        )
        .finally(() => {
          // Unconfirmed descendants keep the ID/slot busy. Retain staging and
          // status for an operator, rather than racing them with deletion/retry.
          if (!job.unsafe) {
            job.endedAt = now();
            if (preparing.get(id) === job) {
              preparing.delete(id);
            }
            activeDownloads--;
          }
          sweepDownloads();
        });

      return job;
    }

    function downloadStatus(token: string, cancel: boolean): Response {
      sweepDownloads();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(token)) {
        return notFound();
      }

      const job = jobs.get(token);
      if (!job) {
        return notFound();
      }

      if (cancel) {
        cancelJob(job);
      } else {
        job.lastActivity = now();
      }

      const snapshot = job.snapshot;
      const current =
        snapshot.state === "preparing" && now() - job.updatedAt > 3_000
          ? { ...snapshot, speedBytesPerSecond: null }
          : snapshot;

      return json(
        current,
        cancel && (current.state === "preparing" || current.state === "canceling") ? 202 : 200,
      );
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

    const requests = new Set<Promise<Response>>();
    const readRoute =
      <Path extends string>(handler: RouteHandler<Path>): RouteHandler<Path> =>
      (request) => {
        const origins = allowedOrigins();
        const host = request.headers.get("host")?.toLowerCase() ?? "";
        const origin = request.headers.get("origin");
        const provenanceOk =
          origins.some((candidate) => new URL(candidate).host === host) &&
          (origin === null || origins.includes(origin.toLowerCase()));
        if (!provenanceOk) {
          return jsonError("Invalid origin.", 403);
        }

        const work = Promise.resolve().then(() =>
          shuttingDown ? jsonError("Server is stopping. Retry later.", 503) : handler(request),
        );

        requests.add(work);
        void work.then(
          () => requests.delete(work),
          () => requests.delete(work),
        );

        return work;
      };

    // Mutations add a same-origin Fetch-Metadata requirement on top of the read
    // guard, which covers no-Origin browser form attempts. CORS stays disabled.
    const mutationRoute = <Path extends string>(handler: RouteHandler<Path>): RouteHandler<Path> =>
      readRoute((request) => {
        const site = request.headers.get("sec-fetch-site");

        return site !== null && site.toLowerCase() !== "same-origin"
          ? jsonError("Invalid origin.", 403)
          : handler(request);
      });

    const sweepExpiredProxies = (): void => {
      for (const [token, proxy] of proxies) {
        if (now() - proxy.createdAt > sessionTtlMs) {
          proxies.delete(token);
        }
      }
    };

    async function resolveVideo(body: ResolveRequest) {
      try {
        if (shuttingDown) {
          return jsonError("Server is stopping. Retry later.", 503);
        }

        const videoUrl = canonicalVideoUrl(body.url);
        const id = videoUrl.slice(-11);
        if (body.mode === "proxy") {
          sweepExpiredProxies();
          if (proxies.size >= 16 || activeExtractions >= 2) {
            return jsonError("Too many HLS sessions. Retry or restart the server.", 429);
          }

          activeExtractions++;

          try {
            const source = await extractHls(videoUrl);
            if (shuttingDown) {
              return jsonError("Server is stopping. Retry later.", 503);
            }

            const token = crypto.randomUUID();
            const proxy = new ProxySession(source, upstreamFetch, now());

            await proxy.prepare(token);
            if (shuttingDown) {
              return jsonError("Server is stopping. Retry later.", 503);
            }

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

        if (deleting.has(id)) {
          return jsonError("Video is being deleted. Retry later.", 409);
        }

        let job = preparing.get(id);
        if (!job) {
          const file = Bun.file(join(mediaRoot, id, "video.mp4"));
          const usable = (await file.exists()) && file.size > 0;
          if (deleting.has(id)) {
            return jsonError("Video is being deleted. Retry later.", 409);
          }
          if (shuttingDown) {
            return jsonError("Server is stopping. Retry later.", 503);
          }

          // Recheck after the filesystem await: another resolve may have started.
          job = preparing.get(id);
          if (!job && usable) {
            return json(
              downloadResult(
                id,
                videoUrl,
                library.metadata(id) ?? {
                  title: "Untitled video",
                  duration: null,
                  channel: null,
                },
              ),
            );
          }

          if (!job) {
            job = startPreparation(id, videoUrl) ?? undefined;
          }
        }
        if (!job) {
          return jsonError("Two downloads are already in progress.", 429);
        }
        if (job.unsafe) {
          return jsonError(
            "A download could not be stopped safely. Stop its processes before restarting the server.",
            503,
          );
        }

        job.lastActivity = now();

        return json({ kind: "preparing", jobToken: job.token }, 202);
      } catch (error) {
        return jsonError(
          error instanceof InputError ? error.message : "Could not prepare video.",
          error instanceof InputError ? 400 : 502,
        );
      }
    }

    async function prepareDownload(id: string, url: string, job: DownloadJob) {
      const dir = join(mediaRoot, id);
      const mp4 = join(dir, "video.mp4");
      const stage = join(dir, `.staging-${crypto.randomUUID()}`);
      let cleanupSafe = true;

      try {
        job.controller.signal.throwIfAborted();
        await mkdir(stage, { recursive: true });
        job.controller.signal.throwIfAborted();

        const stagedMp4 = join(stage, "video.mp4");
        const video = await download(url, stagedMp4, {
          signal: job.controller.signal,
          onProgress: (value) => {
            if (
              job.snapshot.state !== "preparing" ||
              job.controller.signal.aborted ||
              job.snapshot.phase === "finalizing"
            ) {
              return;
            }

            const progress = TransferProgressSchema.safeParse(value);
            if (
              !progress.success ||
              progress.data.phase === "checking" ||
              progress.data.phase === "finalizing"
            ) {
              return;
            }

            job.snapshot = {
              state: "preparing",
              ...progress.data,
              downloadedBytes:
                progress.data.phase === "merging" || progress.data.phase === "processing"
                  ? job.snapshot.downloadedBytes
                  : progress.data.downloadedBytes,
            };
            job.updatedAt = now();
          },
        });

        job.controller.signal.throwIfAborted();
        // Synchronous commit boundary: a later cancel must keep the finished MP4.
        job.snapshot = {
          state: "preparing",
          phase: "finalizing",
          downloadedBytes: job.snapshot.state === "preparing" ? job.snapshot.downloadedBytes : null,
          totalBytes: null,
          totalEstimated: false,
          speedBytesPerSecond: null,
        };

        const staged = Bun.file(stagedMp4);
        if (!(await staged.exists()) || staged.size === 0) {
          throw new InputError("yt-dlp did not create a nonempty MP4 file.");
        }

        await rename(stagedMp4, mp4);
        library.remember(id, video);

        return video;
      } catch (error) {
        if (error instanceof DownloadTerminationError) {
          cleanupSafe = false;
        }
        throw error;
      } finally {
        if (cleanupSafe) {
          try {
            await rm(stage, { recursive: true, force: true });
          } catch {
            // biome-ignore lint/correctness/noUnsafeFinally: Cleanup failure must override cancellation, never claim that partial files were removed.
            throw new InputError("Could not finish download cleanup. Partial files may remain.");
          }
        }
      }
    }

    async function history() {
      return json(await library.list());
    }

    async function watched(id: string, body: WatchRequest) {
      if (!validVideoId(id)) {
        return notFound();
      }

      const video = resolved.get(body.token);
      if (!video || video.id !== id) {
        return jsonError("Unknown playback session. Play again.", 404);
      }

      library.watch(video.id, video);

      return jsonOK();
    }

    async function progress(id: string, body: ProgressRequest) {
      if (!validVideoId(id)) {
        return notFound();
      }

      const video = resolved.get(body.token);
      if (!video || video.id !== id) {
        return jsonError("Unknown playback session. Play again.", 404);
      }

      // Keep the final position so the client can derive watched status.
      library.progress(id, Math.floor(body.positionSeconds));

      return jsonOK();
    }

    async function serveMp4(id: string, method: string, rangeHeader: string | null) {
      if (!validVideoId(id)) {
        return notFound();
      }

      const file = Bun.file(join(mediaRoot, id, "video.mp4"));
      if (!(await file.exists()) || file.size === 0) {
        return jsonError("File missing. Download again.", 404);
      }

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

        return new Response(method === "HEAD" ? null : file.slice(start, end + 1), {
          status: 206,
          headers,
        });
      }

      headers.set("Content-Length", String(size));

      return new Response(method === "HEAD" ? null : file, { headers });
    }

    async function deleteHistory(id: string, filesOnly: boolean) {
      if (!validVideoId(id)) {
        return notFound();
      }
      if (preparing.has(id) || deleting.has(id)) {
        return jsonError("Video is busy. Retry later.", 409);
      }

      deleting.add(id);

      try {
        await rm(join(mediaRoot, id), { recursive: true, force: true });
        if (!filesOnly) {
          library.delete(id);
        }

        for (const [token, video] of resolved) {
          if (video.id === id && (!filesOnly || video.kind === "download")) {
            resolved.delete(token);
            if (video.kind === "proxy") {
              proxies.delete(token);
            }
          }
        }

        return jsonOK();
      } finally {
        deleting.delete(id);
      }
    }

    async function serveProxy(range: string | null, token: string, resource: string) {
      if (range && (range.length > 64 || !/^bytes=\d*-\d*$/.test(range))) {
        return jsonError("Invalid range.", 416);
      }

      const proxy = proxies.get(token);
      if (!proxy) {
        return jsonError("Unknown HLS session. Press Play again.", 404);
      }
      if (now() - proxy.createdAt > sessionTtlMs) {
        proxies.delete(token);

        return jsonError(
          "This HLS session expired. Press Play again to re-extract the video.",
          404,
        );
      }

      return proxy.serve(token, resource, range ?? undefined);
    }

    // Acquire maintenance before binding, so any later bind failure can dispose it.
    sweepTimer = setInterval(
      sweepDownloads,
      Math.max(20, Math.min(1_000, downloadLeaseMs / 2, downloadRetentionMs / 2)),
    );
    sweepTimer.unref();

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
            if ("response" in body) {
              return body.response;
            }

            const input = ResolveRequestSchema.safeParse(body.value);

            return input.success ? resolveVideo(input.data) : jsonError("Invalid request.", 400);
          }),
        },
        "/api/downloads/:jobToken": {
          GET: readRoute((request) => downloadStatus(request.params.jobToken, false)),
          DELETE: mutationRoute((request) => downloadStatus(request.params.jobToken, true)),
        },
        "/api/history": { GET: readRoute(history) },
        // Param routes inline the params so TypeScript infers each handler's
        // BunRequest<route> and typed params, then dispatch to plain arguments.
        "/api/history/:id/watched": {
          POST: mutationRoute(async (request) => {
            const body = await jsonBody(request);
            if ("response" in body) {
              return body.response;
            }

            const input = WatchRequestSchema.safeParse(body.value);

            return input.success
              ? watched(request.params.id, input.data)
              : jsonError("Invalid request.", 400);
          }),
        },
        "/api/history/:id/progress": {
          PUT: mutationRoute((request) => {
            const id = request.params.id;
            if (!validVideoId(id)) {
              return notFound();
            }

            const video = library.metadata(id);
            if (!video) {
              return notFound();
            }
            if (
              video.duration === null ||
              !Number.isFinite(video.duration) ||
              video.duration <= 0
            ) {
              return jsonError("Video duration is unavailable.", 400);
            }

            // Mark completion using trusted metadata, without a separate watched flag.
            library.progress(id, video.duration);

            return jsonOK();
          }),
          DELETE: mutationRoute((request) => {
            const id = request.params.id;
            if (!validVideoId(id) || !library.metadata(id)) {
              return notFound();
            }

            library.progress(id, 0);

            return jsonOK();
          }),
          POST: mutationRoute(async (request) => {
            const body = await jsonBody(request);
            if ("response" in body) {
              return body.response;
            }

            const input = ProgressRequestSchema.safeParse(body.value);

            return input.success
              ? progress(request.params.id, input.data)
              : jsonError("Invalid request.", 400);
          }),
        },
        "/api/history/:id/files": {
          DELETE: mutationRoute((request) => deleteHistory(request.params.id, true)),
        },
        "/api/history/:id": {
          DELETE: mutationRoute((request) => deleteHistory(request.params.id, false)),
        },
        "/api/stream/:id": {
          GET: readRoute((request) =>
            serveMp4(request.params.id, request.method, request.headers.get("range")),
          ),
          HEAD: readRoute((request) =>
            serveMp4(request.params.id, request.method, request.headers.get("range")),
          ),
        },
        "/api/proxy/:token/:resource": {
          GET: readRoute((request) =>
            serveProxy(request.headers.get("range"), request.params.token, request.params.resource),
          ),
        },
      },
      fetch() {
        return notFound();
      },
    });

    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => {
      if (closing) {
        return closing;
      }

      shuttingDown = true;
      clearInterval(sweepTimer);

      for (const job of preparing.values()) {
        cancelJob(job);
      }

      closing = (async () => {
        // Forced HTTP stop does not settle handlers. Drain both, including work
        // admitted before an await, before disposing their database.
        const [http] = await Promise.allSettled([
          Promise.resolve().then(() => server.stop()),
          Promise.allSettled([...requests]),
          Promise.all([...preparing.values()].map((job) => job.done)),
        ]);

        library.close();
        if (http?.status === "rejected") {
          throw http.reason;
        }
        if ([...preparing.values()].some((job) => job.unsafe)) {
          throw new DownloadTerminationError(
            "Download cleanup is unconfirmed. Partial files may remain.",
          );
        }
      })();

      return closing;
    };

    return { server, close, forceStopHttp: () => server.stop(true) };
  } catch (error) {
    clearInterval(sweepTimer);
    library.close();
    throw error;
  }
}
