import { expect, mock, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Library } from "../app/library";
import { startServer } from "../app/server";
import { appFixture } from "./support/app";
import { deferred } from "./support/async";
import { requestResolve } from "./support/http";

const port = Number(process.env.TEST_PORT ?? 0);

test("startup validates before allocating SQLite or cleaning staging", async () => {
  const dir = await mkdtemp(join(tmpdir(), "startup-"));

  try {
    const dataDir = join(dir, "data");
    const stage = join(dataDir, "media", "abcdefghijk", `.staging-${crypto.randomUUID()}`);

    await mkdir(stage, { recursive: true });
    await writeFile(join(stage, "video.mp4"), "in-progress");

    for (const options of [
      { port: -1 },
      { port: 65536 },
      { hostname: "" },
      { hostname: "0.0.0.0" },
      { publicOrigin: "https://example.com/path" },
      { sessionTtlMs: 0 },
      { downloadLeaseMs: -1 },
    ]) {
      expect(() => startServer({ port, dataDir, ...options })).toThrow();
      expect(await Bun.file(join(dataDir, "library.sqlite")).exists()).toBe(false);
      expect(await Bun.file(join(stage, "video.mp4")).text()).toBe("in-progress");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("bind failure closes the acquired library", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bind-"));
  const serve = spyOn(Bun, "serve").mockImplementation(() => {
    throw new Error("Bind failed");
  });
  const close = spyOn(Library.prototype, "close");
  const clearTimer = spyOn(globalThis, "clearInterval");

  try {
    expect(() => startServer({ port, dataDir: dir })).toThrow("Bind failed");
    expect(clearTimer).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    serve.mockRestore();
    close.mockRestore();
    clearTimer.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("close rejects late proxy admission, drains a held request even after forced HTTP stop, then closes SQLite", async () => {
  const dir = await mkdtemp(join(tmpdir(), "late-proxy-"));
  const started = deferred();
  const finish = deferred();
  const dbClose = spyOn(Library.prototype, "close");
  const upstream = mock(async () => {
    throw new Error("Late proxy must not fetch");
  });
  const app = startServer({
    port,
    dataDir: dir,
    extractHls: async () => {
      started.resolve();
      await finish.promise;

      return {
        title: "Late",
        channel: null,
        duration: 10,
        manifest: "https://manifest.googlevideo.com/master.m3u8",
        headers: {},
      };
    },
    upstreamFetch: upstream,
  });
  const response = requestResolve(
    `http://127.0.0.1:${app.server.port}`,
    "https://youtu.be/abcdefghijk",
    {},
    "proxy",
  ).catch(() => null);

  try {
    await Promise.race([
      started.promise,
      response.then(() => {
        throw new Error("Request ended before extraction started");
      }),
    ]);

    const closing = app.close();

    expect(app.close()).toBe(closing);

    const forced = app.forceStopHttp();

    expect(dbClose).not.toHaveBeenCalled();

    finish.resolve();
    await closing;
    await forced;
    await response;

    expect(dbClose).toHaveBeenCalledTimes(1);
    expect(upstream).not.toHaveBeenCalled();
  } finally {
    finish.resolve();
    await app.close();
    await response;
    dbClose.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("close survives the native file-check await without admitting a late download", async () => {
  await using fixture = await appFixture();
  const started = fixture.gate();
  const release = fixture.gate();
  const download = mock(async () => ({
    title: "Must not launch",
    channel: null,
    duration: 10,
  }));
  const base = fixture.start({ download });
  const realFile = Bun.file.bind(Bun);
  const files = spyOn(Bun, "file").mockImplementation(((...args: Parameters<typeof Bun.file>) => {
    const file = realFile(...args);
    if (String(args[0]).endsWith("/abcdefghijk/video.mp4")) {
      const exists = file.exists.bind(file);

      Object.defineProperty(file, "exists", {
        value: async () => {
          started.release();
          await release.promise;

          return exists();
        },
      });
    }

    return file;
  }) as typeof Bun.file);
  const response = requestResolve(base);

  try {
    await Promise.race([
      started.promise,
      response.then(() => {
        throw new Error("Resolve ended before file check");
      }),
    ]);

    const closing = fixture.app.close();

    release.release();

    expect((await response).status).toBe(503);

    await closing;

    expect(download).not.toHaveBeenCalled();
  } finally {
    release.release();
    await fixture.app.close();
    await response;
    files.mockRestore();
  }
});

test("close drains proxy preparation and refuses publication after its upstream await", async () => {
  await using fixture = await appFixture();
  const started = fixture.gate();
  const finish = fixture.gate();
  const base = fixture.start({
    extractHls: async () => ({
      title: "Held",
      duration: 10,
      channel: null,
      manifest: "https://manifest.googlevideo.com/master.m3u8",
      headers: {},
    }),
    upstreamFetch: async () => {
      started.release();
      await finish.promise;

      return new Response(
        '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="original",DEFAULT=NO,URI="audio.m3u8"\n#EXT-X-STREAM-INF:RESOLUTION=160x90,CODECS="avc1.64000c,mp4a.40.2",AUDIO="aac"\nvideo.m3u8',
      );
    },
  });
  const closeDb = spyOn(Library.prototype, "close");
  const response = requestResolve(base, undefined, {}, "proxy");

  try {
    await Promise.race([
      started.promise,
      response.then(() => {
        throw new Error("Resolve ended before upstream preparation");
      }),
    ]);

    const closing = fixture.app.close();

    expect(closeDb).not.toHaveBeenCalled();

    finish.release();

    const result = await response;

    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({
      error: "Server is stopping. Retry later.",
    });

    await closing;

    expect(closeDb).toHaveBeenCalledTimes(1);
  } finally {
    finish.release();
    await fixture.app.close();
    await response;
    closeDb.mockRestore();
  }
});

test("startup resource setup failure closes SQLite without leaving a bound HTTP server", async () => {
  const dir = await mkdtemp(join(tmpdir(), "startup-timer-"));
  const serve = spyOn(Bun, "serve").mockImplementation(
    () => ({ stop: async () => {} }) as unknown as ReturnType<typeof Bun.serve>,
  );
  const timer = spyOn(globalThis, "setInterval").mockImplementation(() => {
    throw new Error("Timer allocation failed");
  });
  const close = spyOn(Library.prototype, "close");

  try {
    expect(() => startServer({ port, dataDir: dir })).toThrow("Timer allocation failed");
    expect(close).toHaveBeenCalledTimes(1);
    expect(serve).not.toHaveBeenCalled();
  } finally {
    serve.mockRestore();
    timer.mockRestore();
    close.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
});
