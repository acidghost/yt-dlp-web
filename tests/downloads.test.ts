import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type Download, type DownloadOptions, DownloadTerminationError } from "../app/media";
import { appFixture } from "./support/app";
import { waitFor } from "./support/async";
import {
  cancelDownload as cancel,
  history,
  progress,
  removeHistory,
  requestResolve,
  waitForSnapshot as until,
  videoUrl as url,
  watched,
} from "./support/http";

async function pending(base: string, videoUrl = url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  let response: Response;

  try {
    response = await requestResolve(base, videoUrl, {}, "mp4", controller.signal);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("Timed out awaiting the resolve HTTP response", {
        cause: error,
      });
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }

  expect(response.status).toBe(202);
  expect(response.headers.get("cache-control")).toBe("no-store");

  const job = await response.json();

  expect(job.kind).toBe("preparing");
  expect(job.jobToken).toMatch(/^[0-9a-f-]{36}$/);

  return job.jobToken as string;
}

const snapshot = (base: string, token: string) =>
  fetch(`${base}/api/downloads/${token}`).then((r) => r.json());

const meta = { title: "Fixture", duration: 10, channel: null };

function controlled(app: Awaited<ReturnType<typeof appFixture>>) {
  const finish = app.gate();
  const cleanup = app.gate();
  const started = app.gate();
  let options: DownloadOptions | undefined;
  let path = "";
  let calls = 0;
  let aborted = false;
  const download: Download = async (_url, output, opts) => {
    calls++;
    path = output;
    options = opts;
    await writeFile(output, "partial");
    started.release();
    await Promise.race([
      finish.promise,
      new Promise<void>((resolve) => {
        if (opts?.signal.aborted) {
          aborted = true;
          resolve();
        } else {
          opts?.signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve();
            },
            { once: true },
          );
        }
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
    started: started.promise,
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

test("MP4 admission does not await a held download; shared progress and cancellation wait for cleanup", async () => {
  await using app = await appFixture();
  const fixture = controlled(app);
  const base = app.start({ download: fixture.download });
  const token = await pending(base);
  const other = await pending(base);

  expect(other).toBe(token);

  await fixture.started;

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
  expect((await removeHistory(base, "abcdefghijk", true)).status).toBe(409);
  expect(await pending(base)).toBe(token);

  fixture.cleanup.release();
  await until(base, token, "canceled");

  expect(await readdir(join(app.dataDir, "media", "abcdefghijk"))).toEqual([]);
  expect((await fetch(`${base}/api/stream/abcdefghijk/720`)).status).toBe(404);
  expect(await history(base)).toEqual([]);
  expect((await cancel(base, token)).status).toBe(200);

  fixture.finish.release();

  const retry = await pending(base);

  expect(retry).not.toBe(token);

  const ready = await until(base, retry, "ready");

  expect(ready.video).toMatchObject({
    kind: "download",
    stream: "/api/stream/abcdefghijk/720",
  });
  expect((await snapshot(base, token)).state).toBe("canceled");
});

test("ready result is stable, completed files are reused, and late cancel keeps them", async () => {
  await using app = await appFixture();
  const finish = app.gate();
  let calls = 0;
  const base = app.start({
    download: async (_url, path) => {
      calls++;
      await finish.promise;
      await writeFile(path, "complete");

      return meta;
    },
  });
  const token = await pending(base);

  finish.release();

  const ready = await until(base, token, "ready");

  expect(await snapshot(base, token)).toEqual(ready);
  expect(await (await cancel(base, token)).json()).toEqual(ready);

  const cached = await requestResolve(base);

  expect(cached.status).toBe(200);
  expect((await cached.json()).kind).toBe("download");
  expect(calls).toBe(1);
  expect(
    await Bun.file(join(app.dataDir, "media", "abcdefghijk", "q-720", "video.mp4")).text(),
  ).toBe("complete");
});

test("job routes retain origin guards, token validation, and private snapshots", async () => {
  await using app = await appFixture();
  const fixture = controlled(app);
  const base = app.start({ download: fixture.download });
  const token = await pending(base);

  for (const method of ["GET", "DELETE"]) {
    const deniedHeaders: Record<string, string>[] = [
      { Host: "evil.example" },
      { Origin: "https://evil.example" },
    ];

    for (const headers of deniedHeaders) {
      expect((await fetch(`${base}/api/downloads/${token}`, { method, headers })).status).toBe(403);
    }

    for (const bad of ["short", crypto.randomUUID()]) {
      expect((await fetch(`${base}/api/downloads/${bad}`, { method })).status).toBe(404);
    }
  }

  expect(
    (
      await fetch(`${base}/api/downloads/${token}`, {
        method: "DELETE",
        headers: { "Sec-Fetch-Site": "cross-site" },
      })
    ).status,
  ).toBe(403);
  expect(JSON.stringify(await snapshot(base, token))).not.toContain(app.dataDir);
  expect(fixture.aborted).toBe(false);
});

test("failures clean staging and publish only safe error snapshots", async () => {
  await using app = await appFixture();
  const finish = app.gate();
  const base = app.start({
    download: async (_url, path) => {
      await finish.promise;
      await writeFile(path, "partial");
      throw new Error("private subprocess URL");
    },
  });
  const token = await pending(base);

  finish.release();

  expect(await until(base, token, "error")).toEqual({
    state: "error",
    error: "Could not prepare video.",
  });
  expect(await readdir(join(app.dataDir, "media", "abcdefghijk"))).toEqual([]);
});

test("cancel cleanup failure is an error, never a successful canceled snapshot", async () => {
  await using app = await appFixture();
  const fixture = controlled(app);
  const base = app.start({ download: fixture.download });
  const token = await pending(base);

  await fixture.started;

  const parent = dirname(dirname(fixture.path));

  await rm(parent, { recursive: true });
  await writeFile(parent, "not a directory");
  await cancel(base, token);
  fixture.cleanup.release();

  expect((await until(base, token, "error")).error).toContain("cleanup");
});

test("shared lease expires through cancellation; polling renews it; terminal expiry keeps MP4", async () => {
  await using app = await appFixture();
  const fixture = controlled(app);
  const base = app.start({
    download: fixture.download,
    downloadLeaseMs: 100,
    downloadRetentionMs: 80,
  });
  const token = await pending(base);

  for (let i = 0; i < 5; i++) {
    app.advanceTime(40);

    expect((await snapshot(base, token)).state).toBe("preparing");
  }

  await fixture.started;
  app.advanceTime(101);

  expect((await snapshot(base, token)).state).toBe("canceling");
  expect(fixture.aborted).toBe(true);

  fixture.cleanup.release();
  await until(base, token, "canceled");
  app.advanceTime(81);

  expect((await fetch(`${base}/api/downloads/${token}`)).status).toBe(404);

  fixture.finish.release();

  const retry = await pending(base);

  await until(base, retry, "ready");
  app.advanceTime(81);

  expect((await fetch(`${base}/api/downloads/${retry}`)).status).toBe(404);
  expect((await requestResolve(base)).status).toBe(200);
});

test("two-worker limit and global cancel do not disturb another video's job", async () => {
  await using app = await appFixture();
  const fixture = controlled(app);
  const base = app.start({ download: fixture.download });
  const one = await pending(base);
  const two = await pending(base, "https://youtu.be/123456789ab");

  expect((await requestResolve(base, "https://youtu.be/aaaaaaaaaaa")).status).toBe(429);

  await cancel(base, one);
  fixture.cleanup.release();
  await until(base, one, "canceled");

  expect((await snapshot(base, two)).state).toBe("preparing");

  fixture.finish.release();
  await until(base, two, "ready");
});

test("unconfirmed subprocess termination preserves staging and keeps the ID/slot busy", async () => {
  await using app = await appFixture();

  app.confirmedNoExternalWriters = true;

  const finish = app.gate();
  const started = app.gate();
  const live = controlled(app);
  const launched: string[] = [];
  let path = "";
  const base = app.start({
    downloadLeaseMs: 100,
    downloadRetentionMs: 80,
    download: async (videoUrl, output, options) => {
      launched.push(videoUrl);
      if (videoUrl !== url) {
        return live.download(videoUrl, output, options);
      }

      path = output;
      await writeFile(path, "partial");
      started.release();
      await finish.promise;
      throw new DownloadTerminationError(
        "Could not stop the download process group safely. Partial files may remain.",
      );
    },
  });
  const token = await pending(base);

  await started.promise;

  const other = await pending(base, "https://youtu.be/123456789ab");

  await live.started;
  await cancel(base, token);
  finish.release();

  expect((await until(base, token, "error")).error).toContain("Partial files may remain");
  expect((await requestResolve(base, "https://youtu.be/aaaaaaaaaaa")).status).toBe(429);

  // Renew the live job, but pass both the unsafe job's lease and retention ages.
  app.advanceTime(90);

  expect((await snapshot(base, other)).state).toBe("preparing");

  app.advanceTime(90);

  expect((await snapshot(base, other)).state).toBe("preparing");
  expect((await snapshot(base, token)).state).toBe("error");
  expect((await requestResolve(base, "https://youtu.be/aaaaaaaaaaa")).status).toBe(429);
  expect(launched).toEqual([url, "https://www.youtube.com/watch?v=123456789ab"]);
  expect(await Bun.file(path).text()).toBe("partial");
  expect((await removeHistory(base, "abcdefghijk", true)).status).toBe(409);
  expect((await requestResolve(base)).status).toBe(503);

  live.cleanup.release();

  await expect(app.app.close()).rejects.toThrow("cleanup is unconfirmed");
});

test.each(["missing", "empty"] as const)(
  "successful metadata with %s output is rejected, cleaned and releases capacity for retry",
  async (output) => {
    await using app = await appFixture();
    const live = controlled(app);
    let calls = 0;
    const base = app.start({
      download: async (videoUrl, path, options) => {
        if (videoUrl !== url) {
          return live.download(videoUrl, path, options);
        }

        calls++;
        if (calls > 1) {
          await writeFile(path, "complete");
        } else if (output === "empty") {
          await writeFile(path, "");
        }

        return meta;
      },
    });

    await pending(base, "https://youtu.be/123456789ab");
    await live.started;

    const token = await pending(base);

    expect(await until(base, token, "error")).toEqual({
      state: "error",
      error: "yt-dlp did not create a nonempty MP4 file.",
    });
    expect((await fetch(`${base}/api/stream/abcdefghijk/720`)).status).toBe(404);
    expect((await watched(base, "abcdefghijk", token)).status).toBe(404);
    expect(await history(base)).toEqual([]);
    expect(await readdir(join(app.dataDir, "media", "abcdefghijk"))).toEqual([]);

    const retry = await pending(base);

    expect(retry).not.toBe(token);

    const ready = await until(base, retry, "ready");

    expect(ready.video.kind).toBe("download");
    expect(calls).toBe(2);
    expect(
      await Bun.file(join(app.dataDir, "media", "abcdefghijk", "q-720", "video.mp4")).text(),
    ).toBe("complete");
  },
);

test("cancel wins before commit even if a downloader finishes and reports late progress", async () => {
  await using app = await appFixture();
  const finish = app.gate();
  let options: DownloadOptions | undefined;
  const started = app.gate();
  const base = app.start({
    download: async (_url, path, opts) => {
      options = opts;
      started.release();
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
    },
  });
  const token = await pending(base);

  await started.promise;
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

  expect(await readdir(join(app.dataDir, "media", "abcdefghijk"))).toEqual([]);
  expect((await fetch(`${base}/api/stream/abcdefghijk/720`)).status).toBe(404);
});

test("cancellation preserves metadata, history, resume, and legacy files", async () => {
  await using app = await appFixture();
  let calls = 0;
  const base = app.start({
    download: async (_url, path, options) => {
      await writeFile(path, ++calls === 1 ? "complete" : "partial");
      if (calls > 1) {
        await new Promise<void>((resolve) => {
          if (options?.signal.aborted) {
            resolve();
          } else {
            options?.signal.addEventListener("abort", () => resolve(), {
              once: true,
            });
          }
        });
        throw new DOMException("Canceled", "AbortError");
      }

      return { ...meta, duration: 120 };
    },
  });
  const first = await until(base, await pending(base), "ready");

  expect((await watched(base, first.video.id, first.video.token)).status).toBe(200);
  expect((await progress(base, first.video.id, first.video.token, 12)).status).toBe(200);

  await removeHistory(base, first.video.id, true);

  const before = await history(base);

  await mkdir(join(app.dataDir, "tmp"));
  await writeFile(join(app.dataDir, "tmp", "legacy.mp4"), "keep");

  const token = await pending(base);

  await cancel(base, token);
  await until(base, token, "canceled");

  expect(await history(base)).toEqual(before);
  expect(before[0]?.positionSeconds).toBe(12);
  expect(await Bun.file(join(app.dataDir, "tmp", "legacy.mp4")).text()).toBe("keep");
  expect((await watched(base, "abcdefghijk", token)).status).toBe(404);
});

test("saved MP4 reuse works while both download slots are occupied", async () => {
  await using app = await appFixture();
  const finish = app.gate();
  const base = app.start({
    download: async (videoUrl, path) => {
      if (videoUrl !== url) {
        await finish.promise;
      }
      await writeFile(path, "complete");

      return meta;
    },
  });

  await until(base, await pending(base), "ready");
  await pending(base, "https://youtu.be/123456789ab");
  await pending(base, "https://youtu.be/aaaaaaaaaaa");

  expect((await requestResolve(base)).status).toBe(200);
});

test("terminal status is bounded without removing reusable MP4s", async () => {
  await using app = await appFixture();
  const base = app.start({
    download: async (_url, path) => {
      await writeFile(path, "complete");

      return meta;
    },
  });
  let first = "";
  let last = "";

  for (let i = 0; i < 65; i++) {
    const token = await pending(base, `https://youtu.be/${String(i).padStart(11, "0")}`);
    if (i === 0) {
      first = token;
    }
    last = token;
    await until(base, token, "ready");
  }

  expect((await fetch(`${base}/api/downloads/${first}`)).status).toBe(404);
  expect((await snapshot(base, last)).state).toBe("ready");
  expect((await requestResolve(base, "https://youtu.be/00000000000")).status).toBe(200);
});

test("speed expires and bytes reset per transfer, while malformed samples cannot corrupt status", async () => {
  await using app = await appFixture();
  const fixture = controlled(app);
  const base = app.start({ download: fixture.download });
  const token = await pending(base);

  await fixture.started;

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

  app.advanceTime(3_100);

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

test("production sweep schedules lease cancellation without a status request", async () => {
  await using app = await appFixture();
  const fixture = controlled(app);
  const base = app.start({ download: fixture.download, downloadLeaseMs: 20 });

  await pending(base);
  await fixture.started;
  app.advanceTime(21);
  await waitFor(
    async () => fixture.aborted,
    (value) => value,
    "background lease cancellation",
  );
});

test("finalization is a commit fence: late cancellation/progress cannot discard a completed file", async () => {
  await using app = await appFixture();
  const finalizing = app.gate();
  const publish = app.gate();
  let progress: DownloadOptions["onProgress"] | undefined;
  const base = app.start({
    download: async (_url, path, options) => {
      progress = options?.onProgress;
      await writeFile(path, "complete");

      return meta;
    },
  });
  const realStat = fs.lstat;
  const files = spyOn(fs, "lstat").mockImplementation((async (
    ...args: Parameters<typeof fs.lstat>
  ) => {
    if (String(args[0]).includes(".staging-") && String(args[0]).endsWith("/video.mp4")) {
      finalizing.release();
      await publish.promise;
    }
    return realStat(...args);
  }) as typeof fs.lstat);

  try {
    const token = await pending(base);

    await finalizing.promise;

    expect(await (await cancel(base, token)).json()).toMatchObject({
      state: "preparing",
      phase: "finalizing",
    });

    progress?.({
      phase: "video",
      downloadedBytes: 1,
      totalBytes: null,
      totalEstimated: false,
      speedBytesPerSecond: 1,
    });

    expect(await snapshot(base, token)).toMatchObject({
      state: "preparing",
      phase: "finalizing",
    });

    publish.release();
    await until(base, token, "ready");

    expect(await (await fetch(`${base}/api/stream/abcdefghijk/720`)).text()).toBe("complete");
  } finally {
    publish.release();
    await app.app.close();
    files.mockRestore();
  }
});

test("deletion reserves the ID through filesystem mutation and token invalidation", async () => {
  await using app = await appFixture();
  const base = app.start();
  const first = await until(base, await pending(base), "ready");
  const deleting = app.gate();
  const remove = app.gate();
  const directory = join(app.dataDir, "media", "abcdefghijk");
  const realRm = fs.rm;
  const files = spyOn(fs, "rm").mockImplementation(async (path, options) => {
    if (String(path) === directory) {
      deleting.release();
      await remove.promise;
    }
    await realRm(path, options);
  });
  const response = removeHistory(base, "abcdefghijk");

  try {
    await Promise.race([
      deleting.promise,
      response.then(() => {
        throw new Error("Deletion ended before reservation check");
      }),
    ]);

    expect((await requestResolve(base)).status).toBe(409);
    expect((await removeHistory(base, "abcdefghijk", true)).status).toBe(409);

    remove.release();

    expect((await response).status).toBe(200);
    expect((await watched(base, first.video.id, first.video.token)).status).toBe(404);
    expect(await history(base)).toEqual([]);

    const retry = await until(base, await pending(base), "ready");

    expect(retry.video.token).not.toBe(first.video.token);
  } finally {
    remove.release();
    await response;
    files.mockRestore();
  }
});
