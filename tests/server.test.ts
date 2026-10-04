import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Library } from "../app/library";
import { canonicalVideoUrl, type Download, InputError } from "../app/media";
import {
  HistoryListSchema,
  PreparationSnapshotSchema,
  PreparingVideoSchema,
  ResolvedVideoSchema,
} from "../app/protocol";
import { startServer } from "../app/server";

const url = "https://www.youtube.com/watch?v=abcdefghijk";
let server: ReturnType<typeof startServer> | undefined;
let testDir: string;
afterEach(async () => {
  await server?.shutdownDownloads();
  server?.stop(true);
  server = undefined;
  if (testDir) await rm(testDir, { recursive: true, force: true });
});

async function launch(
  download?: Download,
  proxy = false,
  reuse = false,
  opts: { publicOrigin?: string; sessionTtlMs?: number } = {},
) {
  if (!reuse) testDir = await mkdtemp(join(tmpdir(), "yt-dlp-web-test-"));
  server = startServer({
    port: 3000,
    dataDir: join(testDir, "data"),
    ...(opts.publicOrigin ? { publicOrigin: opts.publicOrigin } : {}),
    ...(opts.sessionTtlMs !== undefined
      ? { sessionTtlMs: opts.sessionTtlMs }
      : {}),
    ...(proxy
      ? {
          extractHls: async () => ({
            title: "Proxy fixture",
            channel: "Proxy channel",
            duration: 30,
            manifest: "https://manifest.googlevideo.com/master.m3u8",
            headers: { "User-Agent": "fixture-agent" },
          }),
          upstreamFetch: async (
            url: string | URL | Request,
            options?: RequestInit,
          ) => {
            const path = new URL(String(url)).pathname;
            if (path === "/master.m3u8")
              return new Response(
                [
                  "#EXTM3U",
                  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English - original",DEFAULT=NO,URI="https://rr1.googlevideo.com/audio.m3u8"',
                  '#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2",AUDIO="aac"',
                  "https://rr1.googlevideo.com/video.m3u8",
                  '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1920x1080,CODECS="avc1.64002a,mp4a.40.2",AUDIO="aac"',
                  "https://rr1.googlevideo.com/large.m3u8",
                ].join("\n"),
              );
            if (path === "/video.m3u8")
              return new Response(
                '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6,\nseg.ts?range=0-10\n#EXT-X-ENDLIST',
              );
            if (path === "/audio.m3u8")
              return new Response(
                "#EXTM3U\n#EXTINF:6,\nhttps://rr1.googlevideo.com/audio.ts\n#EXT-X-ENDLIST",
              );
            if (path === "/seg.ts")
              return new Response("segment", {
                status:
                  options?.headers && new Headers(options.headers).has("Range")
                    ? 206
                    : 200,
                headers: {
                  "Content-Range": "bytes 0-6/7",
                  "Content-Type": "video/mp2t",
                },
              });
            if (path === "/init.mp4") return new Response("init");
            if (path === "/audio.ts") return new Response("audio");
            throw new Error(`Unexpected upstream path: ${path}`);
          },
        }
      : {}),
    download:
      download ??
      (async (_url, path) => {
        await writeFile(path, "abcdefghij");
        return { title: "Fixture", channel: "Fixture channel", duration: 10 };
      }),
  });
  return `http://127.0.0.1:${server.port}`;
}
// Existing history/stream tests await preparation through the real job API.
// The asynchronous response and cancellation contract have dedicated regressions.
async function complete(
  base: string,
  response: Response,
  headers = {},
): Promise<Response> {
  if (response.status !== 202) return response;
  const { jobToken } = PreparingVideoSchema.parse(await response.json());
  for (let i = 0; i < 500; i++) {
    const read = await fetch(`${base}/api/downloads/${jobToken}`, { headers });
    expect(read.status).toBe(200);
    const snapshot = PreparationSnapshotSchema.parse(await read.json());
    if (snapshot.state === "ready") return Response.json(snapshot.video);
    if (snapshot.state === "error")
      return Response.json({ error: snapshot.error }, { status: 502 });
    await Bun.sleep(5);
  }
  throw new Error("Preparation did not finish");
}
async function resolve(
  base: string,
  videoUrl = url,
  headers: Record<string, string> = {},
) {
  return complete(
    base,
    await fetch(`${base}/api/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ url: videoUrl }),
    }),
    headers,
  );
}

test("validates only single YouTube URLs", () => {
  expect(canonicalVideoUrl("https://youtu.be/abcdefghijk?t=30")).toBe(url);
  for (const bad of [
    "http://www.youtube.com/watch?v=abcdefghijk",
    "https://youtube.com.evil/watch?v=abcdefghijk",
    "https://127.0.0.1/watch?v=abcdefghijk",
    "https://www.youtube.com/playlist?list=abc",
    "https://evil@www.youtube.com/watch?v=abcdefghijk",
  ]) {
    expect(() => canonicalVideoUrl(bad)).toThrow(InputError);
  }
});

test("downloads a private MP4 file before returning a local stream link", async () => {
  const base = await launch();
  const response = await resolve(base);
  expect(response.status).toBe(200);
  const data = ResolvedVideoSchema.parse(await response.json());
  expect(data.kind).toBe("download");
  if (data.kind !== "download") throw new Error("Expected a download");
  expect(data.title).toBe("Fixture");
  expect(data.stream).toBe("/api/stream/abcdefghijk");
  expect(JSON.stringify(data)).not.toContain(testDir);
  const file = Bun.file(join(testDir, "data", "media", data.id, "video.mp4"));
  expect(await file.text()).toBe("abcdefghij");
  expect(
    (await resolve(base, "https://youtube.com.evil/watch?v=abcdefghijk"))
      .status,
  ).toBe(400);
});

test("repeated native MP4 requests reuse the saved file", async () => {
  let downloads = 0;
  const base = await launch(async (_url, path) => {
    downloads++;
    await writeFile(path, "abcdefghij");
    return { title: "Fixture", channel: null, duration: 10 };
  });
  const mp4 = await (await resolve(base)).json();
  expect(mp4.stream).toBe("/api/stream/abcdefghijk");
  expect(downloads).toBe(1);
  await watched(base, mp4.id, mp4.token);
  expect((await history(base))[0].mp4.sizeBytes).toBe(10);

  const replay = await (
    await fetch(`${base}/api/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, mode: "mp4" }),
    })
  ).json();
  expect(replay.stream).toBe(mp4.stream);
  expect(downloads).toBe(1);
  expect((await history(base))[0].mp4.sizeBytes).toBe(10);
});

test("concurrent native MP4 requests share one download", async () => {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let downloads = 0;
  const base = await launch(async (_url, path) => {
    downloads++;
    await gate;
    await writeFile(path, "abcdefghij");
    return { title: "Fixture", channel: null, duration: 10 };
  });
  const request = () => resolve(base);
  const mp4 = request();
  await Bun.sleep(5);
  const replay = request();
  finish();
  expect((await (await mp4).json()).stream).toBe("/api/stream/abcdefghijk");
  expect((await (await replay).json()).stream).toBe("/api/stream/abcdefghijk");
  expect(downloads).toBe(1);
});

test("allows localhost pages on port 3000 but rejects non-loopback hosts", async () => {
  const base = await launch();
  const response = await resolve(base, url, {
    Host: "localhost:3000",
    Origin: "http://localhost:3000",
  });
  expect(response.status).toBe(200);
  const data = await response.json();
  const media = await fetch(`${base}${data.stream}`, {
    headers: { Host: "localhost:3000", Origin: "http://localhost:3000" },
  });
  expect(media.status).toBe(200);
  expect(
    (
      await resolve(base, url, {
        Host: "evil.example:3000",
        Origin: "http://evil.example:3000",
      })
    ).status,
  ).toBe(403);
});

test("proxies a nested HLS master, audio, map and ranged segments without downloading", async () => {
  const base = await launch(undefined, true);
  const response = await fetch(`${base}/api/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, mode: "proxy" }),
  });
  expect(response.status).toBe(200);
  const data = ResolvedVideoSchema.parse(await response.json());
  expect(data.kind).toBe("proxy");
  if (data.kind !== "proxy") throw new Error("Expected a proxy");
  expect("stream" in data).toBe(false);
  expect(data.hls).toMatch(/^\/api\/proxy\/[\da-f-]+\/0$/);
  expect(await Bun.file(join(testDir, "anything.mp4")).exists()).toBe(false);
  const master = await (await fetch(`${base}${data.hls}`)).text();
  expect(master).toContain("DEFAULT=YES");
  expect(master).not.toContain("googlevideo.com");
  expect(master).not.toContain("1920x1080");
  const urls = master.match(/\/api\/proxy\/[\da-f-]+\/\d+/g) ?? [];
  expect(urls.length).toBe(2);
  const video = await (await fetch(`${base}${urls[1]}`)).text();
  expect(video).not.toContain("googlevideo.com");
  const resources = video.match(/\/api\/proxy\/[\da-f-]+\/\d+/g) ?? [];
  expect(resources.length).toBe(2);
  expect(await (await fetch(`${base}${resources[0]}`)).text()).toBe("init");
  const segment = await fetch(`${base}${resources[1]}`, {
    headers: { Range: "bytes=0-6" },
  });
  expect(segment.status).toBe(206);
  expect(segment.headers.get("content-range")).toBe("bytes 0-6/7");
  expect(await segment.text()).toBe("segment");
  expect(
    (
      await fetch(`${base}${resources[1]}`, {
        headers: { Range: "bytes=0-1,3-4" },
      })
    ).status,
  ).toBe(416);
  const audio = await (await fetch(`${base}${urls[0]}`)).text();
  expect(audio).not.toContain("googlevideo.com");
  expect(
    (await fetch(`${base}${data.hls.replace(/\/0$/, "/9999")}`)).status,
  ).toBe(404);
  expect((await fetch(`${base}/api/proxy/unknown/0`)).status).toBe(404);
});

test("bundles the player and its assets", async () => {
  const base = await launch();
  const html = await (await fetch(base)).text();
  expect(html).toContain('type="module"');
  const script = html.match(/<script[^>]+src="([^"]+\.js)"/);
  expect(script).not.toBeNull();
  const scriptUrl = script?.[1];
  if (!scriptUrl) throw new Error("Bundled script URL is missing");
  const bundled = await fetch(new URL(scriptUrl, base));
  expect(bundled.status).toBe(200);
  const client = await bundled.text();
  if (process.env.NODE_ENV === "production") {
    expect(html).not.toContain("bun-hmr");
    expect(client).not.toContain("bun-hmr");
  }
  expect(client).toContain("Hls");
  // Registration code must ship, not just custom-element tags in Lit templates.
  expect(client).toMatch(/customElements\.define\(\s*["']media-controller["']/);
  expect(client).toMatch(
    /customElements\.define\(\s*["']media-playback-rate-menu["']/,
  );
  expect(client).toContain("Proxy YouTube HLS");
  expect(client).toContain("Download + Native MP4");
  expect(client).toContain("Delete files and history");
  expect(client).toContain("Delete files");
  expect(client).toContain("Prepare video");
  expect(client).toContain("No files");
  expect(client).toContain("Open on YouTube");
  expect(client).toContain("Channel unavailable");
  const stylesheet = html.match(/<link[^>]+href="([^"]+\.css)"/);
  expect(stylesheet).not.toBeNull();
  const cssUrl = stylesheet?.[1];
  if (!cssUrl) throw new Error("Bundled stylesheet URL is missing");
  const css = await fetch(new URL(cssUrl, base));
  expect(css.status).toBe(200);
  expect(await css.text()).toContain("video");
  const icon = html.match(/<link[^>]+rel="icon"[^>]+href="([^"]+)"/);
  expect(icon).not.toBeNull();
  const iconUrl = icon?.[1];
  if (!iconUrl) throw new Error("Bundled favicon URL is missing");
  const favicon = await fetch(new URL(iconUrl, base));
  expect(favicon.status).toBe(200);
  expect(favicon.headers.get("content-type")).toContain("image/svg+xml");
  expect(await favicon.text()).toContain("<svg");
});

test("serves full and single byte ranges, including suffix ranges and HEAD", async () => {
  const base = await launch();
  const data = await (await resolve(base)).json();
  const media = `${base}${data.stream}`;
  const full = await fetch(media);
  expect(full.status).toBe(200);
  expect(await full.text()).toBe("abcdefghij");
  expect(full.headers.get("accept-ranges")).toBe("bytes");
  const range = await fetch(media, { headers: { Range: "bytes=2-5" } });
  expect(range.status).toBe(206);
  expect(range.headers.get("content-range")).toBe("bytes 2-5/10");
  expect(range.headers.get("content-length")).toBe("4");
  expect(await range.text()).toBe("cdef");
  expect(
    await (await fetch(media, { headers: { Range: "bytes=-3" } })).text(),
  ).toBe("hij");
  const head = await fetch(media, { method: "HEAD" });
  expect(head.headers.get("content-length")).toBe("10");
  expect(await head.text()).toBe("");
});

test("rejects bad ranges, missing files, large requests and cross-site origins", async () => {
  const base = await launch();
  const data = await (await resolve(base)).json();
  const media = `${base}${data.stream}`;
  for (const range of ["bytes=11-", "bytes=4-2", "bytes=0-1,5-6"]) {
    const response = await fetch(media, { headers: { Range: range } });
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */10");
  }
  expect((await fetch(`${base}/api/stream/unknown`)).status).toBe(404);
  expect((await resolve(base, "x".repeat(3000))).status).toBe(400);
  expect(
    (await resolve(base, url, { Origin: "https://evil.example" })).status,
  ).toBe(403);
  expect((await fetch(`${base}/app/server.ts`)).status).toBe(404);
  const page = await (await fetch(base)).text();
  expect(page).toContain("<video-app");
  await rm(join(testDir, "data", "media", data.id, "video.mp4"));
  expect((await fetch(media)).status).toBe(404);
});

test("download failures are reported and never create a playable session", async () => {
  const base = await launch(async () => {
    throw new InputError("Download failed.");
  });
  const response = await fetch(`${base}/api/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, mode: "mp4" }),
  });
  expect(response.status).toBe(202);
  const { jobToken } = PreparingVideoSchema.parse(
    await response.clone().json(),
  );
  expect((await complete(base, response)).status).toBe(502);
  const snapshot = await fetch(`${base}/api/downloads/${jobToken}`);
  expect(snapshot.status).toBe(200);
  expect(await snapshot.json()).toEqual({
    state: "error",
    error: "Download failed.",
  });
});

test("rejects malformed JSON shapes before preparing or recording a watch", async () => {
  const base = await launch();
  const badResolve = await fetch(`${base}/api/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, mode: 42 }),
  });
  expect(badResolve.status).toBe(400);
  expect(await badResolve.json()).toEqual({ error: "Invalid request." });
  expect(
    ResolvedVideoSchema.safeParse({
      kind: "download",
      id: "abcdefghijk",
      url,
      token: "token",
      title: "Incomplete",
      channel: null,
      duration: null,
    }).success,
  ).toBe(false);

  const resolved = ResolvedVideoSchema.parse(
    await (await resolve(base)).json(),
  );
  const badWatch = await fetch(`${base}/api/history/${resolved.id}/watched`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: 42 }),
  });
  expect(badWatch.status).toBe(400);
  expect(HistoryListSchema.parse(await history(base))).toEqual([]);
});

const history = (base: string) =>
  fetch(`${base}/api/history`).then((r) => r.json());
const watched = (base: string, id: string, token: string, extra = {}) =>
  fetch(`${base}/api/history/${id}/watched`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, ...extra }),
  });

const progress = (
  base: string,
  id: string,
  token: string,
  positionSeconds: unknown,
) =>
  fetch(`${base}/api/history/${id}/progress`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, positionSeconds }),
  });

test("saves playback position for both modes and retains it near the end", async () => {
  const base = await launch(undefined, true);
  const proxy = await (await proxyResolve(base)).json();
  expect(proxy.positionSeconds).toBe(0);
  expect((await progress(base, proxy.id, proxy.token, 12)).status).toBe(200);
  expect(await history(base)).toEqual([]);
  expect((await watched(base, proxy.id, proxy.token)).status).toBe(200);
  expect((await progress(base, proxy.id, "wrong-token", 12)).status).toBe(404);
  expect((await progress(base, "aaaaaaaaaaa", proxy.token, 12)).status).toBe(
    404,
  );
  expect((await progress(base, proxy.id, proxy.token, -1)).status).toBe(400);
  expect((await progress(base, proxy.id, proxy.token, "12")).status).toBe(400);
  expect((await progress(base, proxy.id, proxy.token, 12.8)).status).toBe(200);
  expect((await history(base))[0].positionSeconds).toBe(12);
  expect((await watched(base, proxy.id, proxy.token)).status).toBe(200);
  expect((await history(base))[0].positionSeconds).toBe(12);

  await server?.shutdownDownloads();
  server?.stop(true);
  const restarted = await launch(undefined, true, true);
  const freshProxy = await (await proxyResolve(restarted)).json();
  expect(freshProxy.positionSeconds).toBe(12);
  const mp4 = await (await resolve(restarted)).json();
  expect(mp4.positionSeconds).toBe(12);
  expect(
    (await progress(restarted, freshProxy.id, freshProxy.token, 29)).status,
  ).toBe(200);
  expect((await history(restarted))[0].positionSeconds).toBe(29);
});

test("resets progress without a playback token and preserves history and files across restart", async () => {
  const base = await launch();
  const video = await (await resolve(base)).json();
  await watched(base, video.id, video.token);
  await progress(base, video.id, video.token, 10);
  const before = (await history(base))[0];
  const reset = (id: string, headers = {}) =>
    fetch(`${base}/api/history/${id}/progress`, { method: "DELETE", headers });

  expect(
    (await reset(video.id, { Origin: "https://evil.example" })).status,
  ).toBe(403);
  expect((await reset(video.id, { Host: "evil.example" })).status).toBe(403);
  expect((await history(base))[0].positionSeconds).toBe(10);
  expect((await reset("short")).status).toBe(404);
  expect((await reset("aaaaaaaaaaa")).status).toBe(404);
  const response = await reset(video.id);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  expect((await history(base))[0]).toEqual({ ...before, positionSeconds: 0 });
  expect((await reset(video.id)).status).toBe(200);

  await server?.shutdownDownloads();
  server?.stop(true);
  const restarted = await launch(undefined, false, true);
  expect((await history(restarted))[0]).toEqual({
    ...before,
    positionSeconds: 0,
  });
  expect((await (await resolve(restarted)).json()).positionSeconds).toBe(0);
});

test("marks history fully watched using trusted duration without a playback token", async () => {
  const base = await launch(async (_url, path) => {
    await writeFile(path, "abcdefghij");
    return { title: "Fixture", channel: "Fixture channel", duration: 10.5 };
  });
  const video = await (await resolve(base)).json();
  await watched(base, video.id, video.token);
  const before = (await history(base))[0];
  const mark = (id: string, headers = {}) =>
    fetch(`${base}/api/history/${id}/progress`, { method: "PUT", headers });

  expect(
    (await mark(video.id, { Origin: "https://evil.example" })).status,
  ).toBe(403);
  expect((await mark(video.id, { Host: "evil.example" })).status).toBe(403);
  expect(
    (await mark(video.id, { "Sec-Fetch-Site": "cross-site" })).status,
  ).toBe(403);
  expect((await history(base))[0].positionSeconds).toBe(0);
  expect((await mark("short")).status).toBe(404);
  expect((await mark("aaaaaaaaaaa")).status).toBe(404);
  const response = await mark(video.id);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  expect((await mark(video.id)).status).toBe(200);
  expect((await history(base))[0]).toEqual({
    ...before,
    positionSeconds: video.duration,
  });

  await server?.shutdownDownloads();
  server?.stop(true);
  const restarted = await launch(undefined, false, true);
  expect((await history(restarted))[0]).toEqual({
    ...before,
    positionSeconds: video.duration,
  });
  expect((await (await resolve(restarted)).json()).positionSeconds).toBe(
    video.duration,
  );
  expect(
    (
      await fetch(`${restarted}/api/history/${video.id}/progress`, {
        method: "DELETE",
      })
    ).status,
  ).toBe(200);
  expect((await history(restarted))[0].positionSeconds).toBe(0);
});

test("marking watched refuses unknown or unusable durations without changing progress", async () => {
  for (const duration of [null, 0, -1]) {
    const base = await launch(async (_url, path) => {
      await writeFile(path, "abcdefghij");
      return { title: "Fixture", channel: null, duration };
    });
    const video = await (await resolve(base)).json();
    await watched(base, video.id, video.token);
    const response = await fetch(`${base}/api/history/${video.id}/progress`, {
      method: "PUT",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Video duration is unavailable.",
    });
    expect((await history(base))[0].positionSeconds).toBe(0);
    server?.stop(true);
    server = undefined;
    await rm(testDir, { recursive: true, force: true });
  }
});

test("history is written only for a successfully resolved, playing proxy; survives restart and replays", async () => {
  const base = await launch(undefined, true);
  expect(await history(base)).toEqual([]);
  const resolved = await (
    await fetch(`${base}/api/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, mode: "proxy" }),
    })
  ).json();
  expect(resolved.id).toBe("abcdefghijk");
  expect(resolved.url).toBe(url);
  expect(await history(base)).toEqual([]);
  expect(
    (
      await watched(base, "abcdefghijk", resolved.token, {
        title: "Forged",
        channel: "Forged channel",
      })
    ).status,
  ).toBe(200);
  const rows = HistoryListSchema.parse(await history(base));
  expect(rows).toHaveLength(1);
  const firstRow = rows[0];
  if (!firstRow) throw new Error("Expected a history row");
  expect(rows[0]).toMatchObject({
    id: "abcdefghijk",
    url,
    title: "Proxy fixture",
    channel: "Proxy channel",
    duration: 30,
    mp4: { sizeBytes: null },
  });
  expect(Number.isNaN(Date.parse(firstRow.lastWatchedAt))).toBe(false);
  await server?.shutdownDownloads();
  server?.stop(true);
  const restarted = await launch(undefined, true, true);
  expect(await history(restarted)).toEqual(rows);
  const replay = await fetch(`${restarted}/api/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: firstRow.url, mode: "proxy" }),
  });
  expect(replay.status).toBe(200);
  expect((await replay.json()).token).not.toBe(resolved.token);
});

test("download history checks files, validates watch token and ID, and preserves metadata across restart", async () => {
  const base = await launch();
  const resolved = await (await resolve(base)).json();
  const mediaDir = join(testDir, "data", "media", resolved.id);
  expect(await history(base)).toEqual([]);
  expect((await watched(base, "invalid/../", resolved.token)).status).toBe(404);
  expect((await watched(base, "short", resolved.token)).status).toBe(404);
  expect((await watched(base, "abcdefghijk", "invalid")).status).toBe(404);
  expect((await watched(base, "aaaaaaaaaaa", resolved.token)).status).toBe(404);
  expect(
    (
      await watched(base, "abcdefghijk", resolved.token, {
        title: "Forged",
        channel: "Forged channel",
        url: "https://evil.test",
      })
    ).status,
  ).toBe(200);
  const rows = await history(base);
  expect(rows[0]).toMatchObject({
    id: "abcdefghijk",
    url,
    title: "Fixture",
    channel: "Fixture channel",
    duration: 10,
    mp4: { sizeBytes: 10 },
  });
  await server?.shutdownDownloads();
  server?.stop(true);
  const restarted = await launch(undefined, false, true);
  expect(await history(restarted)).toEqual(rows);
  await writeFile(join(mediaDir, "video.mp4"), "abc");
  expect((await history(restarted))[0].mp4.sizeBytes).toBe(3);
  await rm(join(mediaDir, "video.mp4"));
  expect((await history(restarted))[0]).toMatchObject({
    id: "abcdefghijk",
    title: "Fixture",
    mp4: { sizeBytes: null },
  });
  expect((await watched(restarted, "abcdefghijk", resolved.token)).status).toBe(
    404,
  );
  expect((await resolve(restarted)).status).toBe(200);
  expect((await history(restarted))[0].mp4.sizeBytes).toBe(10);
});

test("repeated plays update a single row, newest first; proxy replay retains downloaded-file badges", async () => {
  const base = await launch(undefined, true);
  const first = await (await resolve(base)).json();
  expect((await watched(base, first.id, first.token)).status).toBe(200);
  const otherUrl = "https://www.youtube.com/watch?v=123456789ab";
  await Bun.sleep(5);
  const second = await (await resolve(base, otherUrl)).json();
  expect((await watched(base, second.id, second.token)).status).toBe(200);
  expect((await history(base)).map((row: { id: string }) => row.id)).toEqual([
    second.id,
    first.id,
  ]);
  await Bun.sleep(5);
  const proxy = await (
    await fetch(`${base}/api/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, mode: "proxy" }),
    })
  ).json();
  expect((await watched(base, first.id, proxy.token)).status).toBe(200);
  const rows = await history(base);
  expect(rows.map((row: { id: string }) => row.id)).toEqual([
    first.id,
    second.id,
  ]);
  expect(rows[0]).toMatchObject({
    title: "Proxy fixture",
    mp4: { sizeBytes: 10 },
  });
  expect(
    (await watched(base, first.id, proxy.token, { url: otherUrl })).status,
  ).toBe(200);
  expect(await history(base)).toHaveLength(2);
  expect(
    (
      await fetch(`${base}/api/history/${first.id}/watched`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://evil.example",
        },
        body: JSON.stringify({ token: proxy.token }),
      })
    ).status,
  ).toBe(403);
});

const removeHistory = (base: string, id: string, filesOnly = false) =>
  fetch(`${base}/api/history/${id}${filesOnly ? "/files" : ""}`, {
    method: "DELETE",
  });

test("downloads reuse stable media across requests and restart; ranges and HEAD still work", async () => {
  let downloads = 0;
  const download: Download = async (_url, path) => {
    downloads++;
    await writeFile(path, "abcdefghij");
    return { title: "Durable fixture", duration: 10, channel: null };
  };
  const base = await launch(download);
  const first = await (await resolve(base)).json();
  expect((await resolve(base)).status).toBe(200);
  expect(downloads).toBe(1);
  expect(first.stream).toBe("/api/stream/abcdefghijk");
  await server?.shutdownDownloads();
  server?.stop(true);
  const restarted = await launch(download, false, true);
  const replay = await (await resolve(restarted)).json();
  expect(downloads).toBe(1);
  expect(replay.title).toBe("Durable fixture");
  expect(replay.stream).toBe(first.stream);
  const range = await fetch(`${restarted}${replay.stream}`, {
    headers: { Range: "bytes=1-2" },
  });
  expect(range.status).toBe(206);
  expect(await range.text()).toBe("bc");
  const head = await fetch(`${restarted}${replay.stream}`, { method: "HEAD" });
  expect(head.headers.get("content-length")).toBe("10");
});

test("failed downloads remove staging, and startup clears abandoned staging without touching legacy tmp", async () => {
  const base = await launch(async (_url, path) => {
    await writeFile(path, "partial");
    throw new Error("yt-dlp failed");
  });
  expect((await resolve(base)).status).toBe(502);
  const mediaDir = join(testDir, "data", "media", "abcdefghijk");
  expect(await Bun.file(join(mediaDir, "video.mp4")).exists()).toBe(false);
  expect(
    (await readdir(mediaDir)).some((name) => name.startsWith(".staging-")),
  ).toBe(false);
  const abandoned = `.staging-${crypto.randomUUID()}`;
  await mkdir(join(mediaDir, abandoned));
  await mkdir(join(testDir, "tmp"));
  await writeFile(join(testDir, "tmp", "legacy.mp4"), "keep");
  await server?.shutdownDownloads();
  server?.stop(true);
  await launch(undefined, false, true);
  expect(await readdir(mediaDir)).not.toContain(abandoned);
  expect(await Bun.file(join(testDir, "tmp", "legacy.mp4")).text()).toBe(
    "keep",
  );
});

test("duplicate prepares share one download and both deletes are idempotent", async () => {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let downloads = 0;
  const base = await launch(async (_url, path) => {
    downloads++;
    await gate;
    await writeFile(path, "abcdefghij");
    return { title: "Fixture", duration: 10, channel: null };
  });
  const one = resolve(base);
  const two = resolve(base);
  // Wait until the shared download has started before testing the busy-ID guard.
  for (let i = 0; downloads === 0 && i < 100; i++) await Bun.sleep(5);
  expect(downloads).toBe(1);
  expect((await removeHistory(base, "abcdefghijk", true)).status).toBe(409);
  expect((await removeHistory(base, "abcdefghijk")).status).toBe(409);
  finish();
  const a = await (await one).json();
  const b = await (await two).json();
  expect(a.stream).toBe(b.stream);
  expect(downloads).toBe(1);
  expect((await watched(base, a.id, a.token)).status).toBe(200);
  expect(
    (
      await fetch(`${base}/api/history/${a.id}/files`, {
        method: "DELETE",
        headers: { Origin: "https://evil.example" },
      })
    ).status,
  ).toBe(403);
  expect((await removeHistory(base, a.id, true)).status).toBe(200);
  expect((await history(base))[0]).toMatchObject({
    mp4: { sizeBytes: null },
  });
  expect((await fetch(`${base}${a.stream}`)).status).toBe(404);
  expect((await removeHistory(base, a.id, true)).status).toBe(200);
  const again = await (await resolve(base)).json();
  expect(downloads).toBe(2);
  expect((await watched(base, a.id, again.token)).status).toBe(200);
  expect((await removeHistory(base, a.id)).status).toBe(200);
  expect(await history(base)).toEqual([]);
  expect((await removeHistory(base, a.id)).status).toBe(200);
  expect((await removeHistory(base, "short")).status).toBe(404);
  expect((await removeHistory(base, "../secret")).status).toBe(404);
  expect((await watched(base, a.id, again.token)).status).toBe(404);
});

test("rejects the old UUID history schema without touching PoC files", async () => {
  testDir = await mkdtemp(join(tmpdir(), "yt-dlp-web-test-"));
  const dataDir = join(testDir, "data");
  await mkdir(dataDir);
  const db = new Database(join(dataDir, "library.sqlite"), { create: true });
  db.run(`CREATE TABLE videos (
    id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, duration REAL,
    last_watched_at TEXT NOT NULL, media_token TEXT
  ); PRAGMA user_version = 1;`);
  const oldToken = crypto.randomUUID();
  db.query("INSERT INTO videos VALUES (?, ?, ?, ?, ?)").run(
    "abcdefghijk",
    "Older video",
    42,
    "2026-01-01T00:00:00.000Z",
    oldToken,
  );
  db.close();
  const legacyFile = join(testDir, "tmp", `${oldToken}.mp4`);
  await mkdir(join(testDir, "tmp"));
  await writeFile(legacyFile, "do not touch");
  expect(() => new Library(dataDir)).toThrow(
    /Unsupported library schema.*reset/i,
  );
  expect(await Bun.file(legacyFile).text()).toBe("do not touch");
});

test("opens an existing current-schema database without resetting history", async () => {
  testDir = await mkdtemp(join(tmpdir(), "yt-dlp-web-test-"));
  const dataDir = join(testDir, "data");
  await mkdir(dataDir);
  const db = new Database(join(dataDir, "library.sqlite"), { create: true });
  db.run(`CREATE TABLE videos (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        duration REAL,
        last_watched_at TEXT,
        channel TEXT,
        position_seconds REAL NOT NULL DEFAULT 0
      ); PRAGMA user_version = 4;`);
  db.query(
    "INSERT INTO videos (id, title, last_watched_at) VALUES (?, ?, ?)",
  ).run("abcdefghijk", "Existing history", "2026-01-01T00:00:00.000Z");
  db.close();
  const base = await launch(undefined, false, true);
  expect((await history(base))[0]).toMatchObject({
    title: "Existing history",
    positionSeconds: 0,
  });
});

test("handoff modes map to their preparation requests without recording a watch", async () => {
  const base = await launch(undefined, true);
  const { parseHandoff, resolveKind } = await import("../app/client/handoff");
  for (const mode of [null, "mp4"] as const) {
    const handoff = parseHandoff(
      `?url=${encodeURIComponent(url)}${mode ? `&mode=${mode}` : ""}`,
    );
    if (!handoff || "error" in handoff)
      throw new Error("Invalid fixture handoff");
    const response = await complete(
      base,
      await fetch(`${base}/api/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: handoff.url,
          mode: handoff.mode === "mp4" ? "mp4" : resolveKind(handoff.mode),
        }),
      }),
    );
    expect(response.status).toBe(200);
    const result = await response.json();
    if (mode === null) expect(result.hls).toStartWith("/api/proxy/");
    expect(result.stream === undefined).toBe(mode === null);
  }
  expect(await history(base)).toEqual([]);
  expect(parseHandoff(`?url=${encodeURIComponent(url)}&mode=bad`)).toEqual({
    error: "Unknown playback mode.",
  });
  const foreign = parseHandoff(
    "?url=https%3A%2F%2Fevil.example%2Fwatch%3Fv%3Dabcdefghijk",
  );
  if (!foreign || "error" in foreign) throw new Error("Invalid HTTPS fixture");
  const rejected = await fetch(`${base}/api/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: foreign.url, mode: resolveKind(foreign.mode) }),
  });
  expect(rejected.status).toBe(400);
  expect(await history(base)).toEqual([]);
});

test("rejects changed constraints even when columns and user_version match", async () => {
  testDir = await mkdtemp(join(tmpdir(), "yt-dlp-web-test-"));
  const dataDir = join(testDir, "data");
  await mkdir(dataDir);
  const db = new Database(join(dataDir, "library.sqlite"), { create: true });
  db.run(`CREATE TABLE videos (
    id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, duration REAL,
    last_watched_at TEXT, channel TEXT,
    position_seconds REAL NOT NULL DEFAULT 0 CHECK(position_seconds >= 0)
  ); PRAGMA user_version = 4;`);
  db.close();
  expect(() => new Library(dataDir)).toThrow(
    /Unsupported library schema.*reset/i,
  );
});

test("reset-db removes only the database and allows a fresh start", async () => {
  testDir = await mkdtemp(join(tmpdir(), "yt-dlp-web-test-"));
  const dataDir = join(testDir, "data");
  await mkdir(dataDir);
  const db = new Database(join(dataDir, "library.sqlite"), { create: true });
  db.run("CREATE TABLE videos (id TEXT PRIMARY KEY)");
  db.close();
  const media = join(dataDir, "media", "abcdefghijk", "video.mp4");
  await mkdir(join(dataDir, "media", "abcdefghijk"), { recursive: true });
  await writeFile(media, "saved video");
  const reset = Bun.spawnSync({
    cmd: [
      process.execPath,
      join(import.meta.dir, "../app/index.ts"),
      "--reset-db",
    ],
    env: { ...process.env, DATA_DIR: dataDir },
  });
  expect(reset.exitCode).toBe(0);
  expect(await Bun.file(join(dataDir, "library.sqlite")).exists()).toBe(false);
  expect(await Bun.file(media).text()).toBe("saved video");
  const base = await launch(undefined, false, true);
  expect(await history(base)).toEqual([]);
});

const proxyResolve = (base: string) =>
  fetch(`${base}/api/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, mode: "proxy" }),
  });

test("healthz answers probes from any Host and never emits CORS headers", async () => {
  const base = await launch();
  const probe = await fetch(`${base}/healthz`, {
    headers: { Host: "10.42.0.7:3000" },
  });
  expect(probe.status).toBe(200);
  expect(await probe.json()).toEqual({ ok: true });
  expect(probe.headers.get("access-control-allow-origin")).toBeNull();
  const mutation = await resolve(base);
  expect(mutation.headers.get("access-control-allow-origin")).toBeNull();
});

test("PUBLIC_ORIGIN admits only its host for reads and mutations", async () => {
  const base = await launch(undefined, true, false, {
    publicOrigin: "https://player.example.com",
  });
  const ingress = {
    Host: "player.example.com",
    Origin: "https://player.example.com",
  };
  // Note: under `just dev`, Bun's own HTML-route guard blocks foreign Hosts
  // for the page itself; the compiled binary serves it fine (covered by the
  // build smoke test). Here we verify the API surface we control.
  const listing = await fetch(`${base}/api/history`, {
    headers: { Host: "player.example.com" },
  });
  expect(listing.status).toBe(200);
  expect(await listing.json()).toEqual([]);
  const resolved = await (
    await fetch(`${base}/api/resolve`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...ingress,
        "Sec-Fetch-Site": "same-origin",
      },
      body: JSON.stringify({ url, mode: "proxy" }),
    })
  ).json();
  expect(
    (
      await fetch(`${base}${resolved.hls}`, {
        headers: { Host: "player.example.com" },
      })
    ).status,
  ).toBe(200);
  // Loopback names are no longer accepted once an ingress origin is set.
  expect((await resolve(base)).status).toBe(403);
  expect(
    (
      await fetch(`${base}/api/history`, {
        headers: { Host: "localhost:3000" },
      })
    ).status,
  ).toBe(403);
  // Foreign Origin is denied for both reads and mutations.
  expect(
    (
      await fetch(`${base}/api/history`, {
        headers: { Host: "player.example.com", Origin: "https://evil.example" },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await fetch(`${base}/api/resolve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Host: "player.example.com",
          Origin: "https://evil.example",
        },
        body: JSON.stringify({ url, mode: "proxy" }),
      })
    ).status,
  ).toBe(403);
});

test("no-Origin browser attempts and cross-site fetch metadata on mutations are denied", async () => {
  const base = await launch();
  const post = async (headers: Record<string, string>) =>
    complete(
      base,
      await fetch(`${base}/api/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ url }),
      }),
      headers,
    );
  expect((await post({ "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
  expect((await post({ "Sec-Fetch-Site": "same-site" })).status).toBe(403);
  expect((await post({ "Sec-Fetch-Site": "same-origin" })).status).toBe(200);
  const resolved = await (await post({})).json();
  expect((await watched(base, resolved.id, resolved.token)).status).toBe(200);
  expect(
    (
      await fetch(`${base}/api/history/${resolved.id}`, {
        method: "DELETE",
        headers: { "Sec-Fetch-Site": "cross-site" },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await fetch(`${base}/api/history/${resolved.id}`, {
        method: "DELETE",
        headers: { "Sec-Fetch-Site": "same-origin" },
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await fetch(`${base}/api/stream/${resolved.id}`, {
        headers: { Host: "evil.example:3000" },
      })
    ).status,
  ).toBe(403);
});

test("proxy sessions expire with an actionable message and evict to free capacity", async () => {
  const base = await launch(undefined, true, false, {
    sessionTtlMs: 1200,
  });
  const first = await (await proxyResolve(base)).json();
  expect((await fetch(`${base}${first.hls}`)).status).toBe(200);
  await Bun.sleep(1300);
  const expired = await fetch(`${base}${first.hls}`);
  expect(expired.status).toBe(404);
  const message = (await expired.json()).error;
  expect(message).toContain("expired");
  expect(message).toContain("Play again");
  for (let i = 0; i < 16; i++)
    expect((await proxyResolve(base)).status).toBe(200);
  expect((await proxyResolve(base)).status).toBe(429);
  await Bun.sleep(1300);
  const fresh = await proxyResolve(base);
  expect(fresh.status).toBe(200);
  expect((await fetch(`${base}${(await fresh.json()).hls}`)).status).toBe(200);
});
