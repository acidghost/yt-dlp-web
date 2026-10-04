import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type Download,
  type DownloadOptions,
  DownloadTerminationError,
} from "../app/media";
import { startServer } from "../app/server";

const url = "https://www.youtube.com/watch?v=abcdefghijk";
let server: ReturnType<typeof startServer> | undefined;
let dir = "";
const releases: (() => void)[] = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await server?.shutdownDownloads();
  await server?.stop(true);
  server = undefined;
  if (dir) await rm(dir, { recursive: true, force: true });
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  releases.push(release);
  return { promise, release };
}
async function launch(download: Download, opts = {}) {
  dir = await mkdtemp(join(tmpdir(), "yt-dlp-downloads-"));
  server = startServer({ port: 3000, dataDir: dir, download, ...opts });
  return `http://127.0.0.1:${server.port}`;
}
function start(base: string, videoUrl = url) {
  return fetch(`${base}/api/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: videoUrl, mode: "mp4" }),
  });
}
async function pending(base: string, videoUrl = url) {
  const response = await Promise.race([
    start(base, videoUrl),
    Bun.sleep(300).then(() => null),
  ]);
  expect(response?.status).toBe(202);
  if (!response) throw new Error("Resolve waited for the download");
  expect(response.headers.get("cache-control")).toBe("no-store");
  const job = await response.json();
  expect(job.kind).toBe("preparing");
  expect(job.jobToken).toMatch(/^[0-9a-f-]{36}$/);
  return job.jobToken as string;
}
const snapshot = (base: string, token: string) =>
  fetch(`${base}/api/downloads/${token}`).then((r) => r.json());
const cancel = (base: string, token: string) =>
  fetch(`${base}/api/downloads/${token}`, { method: "DELETE" });
async function until(base: string, token: string, state: string) {
  for (let i = 0; i < 200; i++) {
    const result = await snapshot(base, token);
    if (result.state === state) return result;
    await Bun.sleep(5);
  }
  throw new Error(`Job did not reach ${state}`);
}
const meta = { title: "Fixture", duration: 10, channel: null };

function controlled() {
  const finish = gate();
  const cleanup = gate();
  let options: DownloadOptions | undefined;
  let path = "";
  let calls = 0;
  let aborted = false;
  const download: Download = async (_url, output, opts) => {
    calls++;
    path = output;
    options = opts;
    await writeFile(output, "partial");
    await Promise.race([
      finish.promise,
      new Promise<void>((resolve) => {
        if (opts?.signal.aborted) {
          aborted = true;
          resolve();
        } else
          opts?.signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve();
            },
            { once: true },
          );
      }),
    ]);
    if (opts?.signal.aborted) {
      await cleanup.promise;
      throw new DOMException("Canceled", "AbortError");
    }
    return meta;
  };
  return {
    download,
    finish,
    cleanup,
    get options() {
      return options;
    },
    get path() {
      return path;
    },
    get calls() {
      return calls;
    },
    get aborted() {
      return aborted;
    },
  };
}

test("MP4 resolve returns immediately; shared progress and cancellation wait for cleanup", async () => {
  const fixture = controlled();
  const base = await launch(fixture.download);
  const token = await pending(base);
  const other = await pending(base);
  expect(other).toBe(token);
  for (let i = 0; !fixture.options && i < 100; i++) await Bun.sleep(5);
  expect(fixture.calls).toBe(1);
  fixture.options?.onProgress({
    phase: "video",
    downloadedBytes: 50,
    totalBytes: 100,
    totalEstimated: true,
    speedBytesPerSecond: 20,
  });
  expect(await snapshot(base, token)).toMatchObject({
    state: "preparing",
    phase: "video",
    downloadedBytes: 50,
    totalBytes: 100,
    totalEstimated: true,
    speedBytesPerSecond: 20,
  });
  const response = await cancel(base, other);
  expect(response.status).toBe(202);
  expect((await response.json()).state).toBe("canceling");
  expect(fixture.aborted).toBe(true);
  expect(await Bun.file(fixture.path).exists()).toBe(true);
  expect((await snapshot(base, token)).state).toBe("canceling");
  expect((await cancel(base, token)).status).toBe(202);
  expect(
    (await fetch(`${base}/api/history/abcdefghijk/files`, { method: "DELETE" }))
      .status,
  ).toBe(409);
  expect(await pending(base)).toBe(token);
  fixture.cleanup.release();
  await until(base, token, "canceled");
  expect(await readdir(join(dir, "media", "abcdefghijk"))).toEqual([]);
  expect((await fetch(`${base}/api/stream/abcdefghijk`)).status).toBe(404);
  expect(await (await fetch(`${base}/api/history`)).json()).toEqual([]);
  expect((await cancel(base, token)).status).toBe(200);
  fixture.finish.release();
  const retry = await pending(base);
  expect(retry).not.toBe(token);
  const ready = await until(base, retry, "ready");
  expect(ready.video.stream).toBe("/api/stream/abcdefghijk");
  expect((await snapshot(base, token)).state).toBe("canceled");
});

test("ready result is stable, completed files are reused, and late cancel keeps them", async () => {
  const finish = gate();
  let calls = 0;
  const base = await launch(async (_url, path) => {
    calls++;
    await finish.promise;
    await writeFile(path, "complete");
    return meta;
  });
  const token = await pending(base);
  finish.release();
  const ready = await until(base, token, "ready");
  expect(await snapshot(base, token)).toEqual(ready);
  expect(await (await cancel(base, token)).json()).toEqual(ready);
  const cached = await start(base);
  expect(cached.status).toBe(200);
  expect((await cached.json()).kind).toBe("download");
  expect(calls).toBe(1);
  expect(
    await Bun.file(join(dir, "media", "abcdefghijk", "video.mp4")).text(),
  ).toBe("complete");
});

test("job routes retain origin guards, token validation, and private snapshots", async () => {
  const fixture = controlled();
  const base = await launch(fixture.download);
  const token = await pending(base);
  for (const method of ["GET", "DELETE"]) {
    const deniedHeaders: Record<string, string>[] = [
      { Host: "evil.example" },
      { Origin: "https://evil.example" },
    ];
    for (const headers of deniedHeaders)
      expect(
        (await fetch(`${base}/api/downloads/${token}`, { method, headers }))
          .status,
      ).toBe(403);
    for (const bad of ["short", crypto.randomUUID()])
      expect(
        (await fetch(`${base}/api/downloads/${bad}`, { method })).status,
      ).toBe(404);
  }
  expect(
    (
      await fetch(`${base}/api/downloads/${token}`, {
        method: "DELETE",
        headers: { "Sec-Fetch-Site": "cross-site" },
      })
    ).status,
  ).toBe(403);
  expect(JSON.stringify(await snapshot(base, token))).not.toContain(dir);
  expect(fixture.aborted).toBe(false);
});

test("failures clean staging and publish only safe error snapshots", async () => {
  const finish = gate();
  const base = await launch(async (_url, path) => {
    await finish.promise;
    await writeFile(path, "partial");
    throw new Error("private subprocess URL");
  });
  const token = await pending(base);
  finish.release();
  expect(await until(base, token, "error")).toEqual({
    state: "error",
    error: "Could not prepare video.",
  });
  expect(await readdir(join(dir, "media", "abcdefghijk"))).toEqual([]);
});

test("cancel cleanup failure is an error, never a successful canceled snapshot", async () => {
  const fixture = controlled();
  const base = await launch(fixture.download);
  const token = await pending(base);
  for (
    let i = 0;
    (!fixture.path || !(await Bun.file(fixture.path).exists())) && i < 100;
    i++
  )
    await Bun.sleep(5);
  const parent = dirname(dirname(fixture.path));
  await rm(parent, { recursive: true });
  await writeFile(parent, "not a directory");
  await cancel(base, token);
  fixture.cleanup.release();
  expect((await until(base, token, "error")).error).toContain("cleanup");
});

test("shared lease expires through cancellation; polling renews it; terminal expiry keeps MP4", async () => {
  const fixture = controlled();
  const base = await launch(fixture.download, {
    downloadLeaseMs: 100,
    downloadRetentionMs: 80,
  });
  const token = await pending(base);
  for (let i = 0; i < 5; i++) {
    await Bun.sleep(40);
    expect((await snapshot(base, token)).state).toBe("preparing");
  }
  await Bun.sleep(160);
  expect(fixture.aborted).toBe(true);
  fixture.cleanup.release();
  await until(base, token, "canceled");
  await Bun.sleep(130);
  expect((await fetch(`${base}/api/downloads/${token}`)).status).toBe(404);
  fixture.finish.release();
  const retry = await pending(base);
  await until(base, retry, "ready");
  await Bun.sleep(130);
  expect((await fetch(`${base}/api/downloads/${retry}`)).status).toBe(404);
  expect((await start(base)).status).toBe(200);
});

test("two-worker limit and global cancel do not disturb another video's job", async () => {
  const fixture = controlled();
  const base = await launch(fixture.download);
  const one = await pending(base);
  const two = await pending(base, "https://youtu.be/123456789ab");
  expect((await start(base, "https://youtu.be/aaaaaaaaaaa")).status).toBe(429);
  await cancel(base, one);
  fixture.cleanup.release();
  await until(base, one, "canceled");
  expect((await snapshot(base, two)).state).toBe("preparing");
  fixture.finish.release();
  await until(base, two, "ready");
});

test("unconfirmed subprocess termination preserves staging and keeps the ID/slot busy", async () => {
  const finish = gate();
  let path = "";
  const base = await launch(async (_url, output) => {
    path = output;
    await writeFile(path, "partial");
    await finish.promise;
    throw new DownloadTerminationError(
      "Could not stop the download process group safely. Partial files may remain.",
    );
  });
  const token = await pending(base);
  for (let i = 0; (!path || !(await Bun.file(path).exists())) && i < 100; i++)
    await Bun.sleep(5);
  await cancel(base, token);
  finish.release();
  expect((await until(base, token, "error")).error).toContain(
    "Partial files may remain",
  );
  expect(await Bun.file(path).text()).toBe("partial");
  expect(
    (await fetch(`${base}/api/history/abcdefghijk/files`, { method: "DELETE" }))
      .status,
  ).toBe(409);
  expect((await start(base)).status).toBe(503);
});

test("cancel wins before commit even if a downloader finishes and reports late progress", async () => {
  const finish = gate();
  let options: DownloadOptions | undefined;
  const base = await launch(async (_url, path, opts) => {
    options = opts;
    await finish.promise;
    opts?.onProgress({
      phase: "merging",
      downloadedBytes: null,
      totalBytes: null,
      totalEstimated: false,
      speedBytesPerSecond: null,
    });
    await writeFile(path, "complete");
    return meta;
  });
  const token = await pending(base);
  for (let i = 0; !options && i < 100; i++) await Bun.sleep(5);
  options?.onProgress({
    phase: "merging",
    downloadedBytes: null,
    totalBytes: null,
    totalEstimated: false,
    speedBytesPerSecond: null,
  });
  expect((await snapshot(base, token)).phase).toBe("merging");
  await cancel(base, token);
  finish.release();
  await until(base, token, "canceled");
  expect(await readdir(join(dir, "media", "abcdefghijk"))).toEqual([]);
  expect((await fetch(`${base}/api/stream/abcdefghijk`)).status).toBe(404);
});

test("cancellation preserves metadata, history, resume, and legacy files", async () => {
  let calls = 0;
  const base = await launch(async (_url, path, options) => {
    await writeFile(path, ++calls === 1 ? "complete" : "partial");
    if (calls > 1) {
      await new Promise<void>((resolve) => {
        if (options?.signal.aborted) resolve();
        else
          options?.signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
      });
      throw new DOMException("Canceled", "AbortError");
    }
    return { ...meta, duration: 120 };
  });
  const first = await until(base, await pending(base), "ready");
  for (const [path, body] of [
    ["watched", { token: first.video.token }],
    ["progress", { token: first.video.token, positionSeconds: 12 }],
  ] as const)
    expect(
      (
        await fetch(`${base}/api/history/abcdefghijk/${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
      ).status,
    ).toBe(200);
  await fetch(`${base}/api/history/abcdefghijk/files`, { method: "DELETE" });
  const before = await (await fetch(`${base}/api/history`)).json();
  await mkdir(join(dir, "tmp"));
  await writeFile(join(dir, "tmp", "legacy.mp4"), "keep");
  const token = await pending(base);
  await cancel(base, token);
  await until(base, token, "canceled");
  expect(await (await fetch(`${base}/api/history`)).json()).toEqual(before);
  expect(before[0].positionSeconds).toBe(12);
  expect(await Bun.file(join(dir, "tmp", "legacy.mp4")).text()).toBe("keep");
  expect(
    (
      await fetch(`${base}/api/history/abcdefghijk/watched`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      })
    ).status,
  ).toBe(404);
});

test("saved MP4 reuse works while both download slots are occupied", async () => {
  const finish = gate();
  const base = await launch(async (videoUrl, path) => {
    if (videoUrl !== url) await finish.promise;
    await writeFile(path, "complete");
    return meta;
  });
  await until(base, await pending(base), "ready");
  await pending(base, "https://youtu.be/123456789ab");
  await pending(base, "https://youtu.be/aaaaaaaaaaa");
  expect((await start(base)).status).toBe(200);
});

test("terminal status is bounded without removing reusable MP4s", async () => {
  const base = await launch(async (_url, path) => {
    await writeFile(path, "complete");
    return meta;
  });
  let first = "";
  let last = "";
  for (let i = 0; i < 65; i++) {
    const token = await pending(
      base,
      `https://youtu.be/${String(i).padStart(11, "0")}`,
    );
    if (i === 0) first = token;
    last = token;
    await until(base, token, "ready");
  }
  expect((await fetch(`${base}/api/downloads/${first}`)).status).toBe(404);
  expect((await snapshot(base, last)).state).toBe("ready");
  expect((await start(base, "https://youtu.be/00000000000")).status).toBe(200);
});

test("speed expires and bytes reset per transfer, while malformed samples cannot corrupt status", async () => {
  const fixture = controlled();
  const base = await launch(fixture.download);
  const token = await pending(base);
  for (let i = 0; !fixture.options && i < 100; i++) await Bun.sleep(5);
  const report = fixture.options?.onProgress;
  expect(report).toBeDefined();
  report?.({
    phase: "video",
    downloadedBytes: 50,
    totalBytes: 100,
    totalEstimated: false,
    speedBytesPerSecond: 20,
  });
  report?.({
    phase: "video",
    downloadedBytes: Number.NaN,
    totalBytes: -1,
    totalEstimated: false,
    speedBytesPerSecond: Number.POSITIVE_INFINITY,
  });
  report?.({
    phase: "finalizing",
    downloadedBytes: 100,
    totalBytes: 100,
    totalEstimated: false,
    speedBytesPerSecond: null,
  });
  expect(await snapshot(base, token)).toMatchObject({
    phase: "video",
    downloadedBytes: 50,
  });
  await Bun.sleep(3_100);
  expect((await snapshot(base, token)).speedBytesPerSecond).toBeNull();
  report?.({
    phase: "audio",
    downloadedBytes: 5,
    totalBytes: null,
    totalEstimated: false,
    speedBytesPerSecond: null,
  });
  expect(await snapshot(base, token)).toMatchObject({
    phase: "audio",
    downloadedBytes: 5,
    totalBytes: null,
    speedBytesPerSecond: null,
  });
  report?.({
    phase: "merging",
    downloadedBytes: null,
    totalBytes: null,
    totalEstimated: false,
    speedBytesPerSecond: null,
  });
  expect(await snapshot(base, token)).toMatchObject({
    phase: "merging",
    downloadedBytes: 5,
    totalBytes: null,
    speedBytesPerSecond: null,
  });
});
