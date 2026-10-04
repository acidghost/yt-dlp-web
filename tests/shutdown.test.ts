import { expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Library } from "../app/library";
import { createShutdown, registerSignals } from "../app/lifecycle";
import { appFixture } from "./support/app";
import { deferred } from "./support/async";
import { requestResolve } from "./support/http";

test("both signals share real application shutdown; staging/SQLite outlive download cleanup", async () => {
  await using fixture = await appFixture();
  const started = fixture.gate();
  const cleanup = fixture.gate();
  const base = fixture.start({
    download: async (_url, path, options) => {
      await writeFile(path, "partial");
      started.release();
      await new Promise<void>((resolve) => {
        if (options?.signal.aborted) {
          resolve();
        } else {
          options?.signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
        }
      });
      await cleanup.promise;
      throw new DOMException("Canceled", "AbortError");
    },
  });
  const response = await requestResolve(base);

  expect(response.status).toBe(202);

  await started.promise;

  const complete = mock();
  const cancelTimer = mock();
  const closeDb = spyOn(Library.prototype, "close");
  const shutdown = createShutdown({
    app: fixture.app,
    log: mock(),
    complete,
    schedule: (_callback, ms) => {
      expect(ms).toBe(5000);

      return cancelTimer;
    },
  });
  const signals = new EventEmitter();
  const unsubscribe = registerSignals(signals, shutdown);

  try {
    signals.emit("SIGTERM");

    const closing = shutdown("SIGTERM");

    signals.emit("SIGINT");

    expect(shutdown("SIGINT")).toBe(closing);
    expect(complete).not.toHaveBeenCalled();
    expect(closeDb).not.toHaveBeenCalled();
    expect(
      (await readdir(join(fixture.dataDir, "media", "abcdefghijk"))).some((name) =>
        name.startsWith(".staging-"),
      ),
    ).toBe(true);

    cleanup.release();

    expect(await closing).toBe("graceful");
    expect(complete.mock.calls).toEqual([["graceful"]]);
    expect(cancelTimer).toHaveBeenCalledTimes(1);
    expect(closeDb).toHaveBeenCalledTimes(1);
    expect(await readdir(join(fixture.dataDir, "media", "abcdefghijk"))).toEqual([]);
    await expect(fetch(`${base}/healthz`)).rejects.toThrow();
  } finally {
    cleanup.release();
    await fixture.app.close();
    unsubscribe();
    closeDb.mockRestore();
  }

  expect(signals.listenerCount("SIGTERM")).toBe(0);
  expect(signals.listenerCount("SIGINT")).toBe(0);
});

test("five-second deadline force-stops HTTP without claiming or abandoning pending cleanup", async () => {
  const cleanup = deferred();
  const app = {
    close: mock(() => cleanup.promise),
    forceStopHttp: mock(async () => {}),
  };
  let deadline!: () => void;
  const complete = mock();
  const log = mock();
  const shutdown = createShutdown({
    app,
    complete,
    log,
    schedule: (callback, ms) => {
      expect(ms).toBe(5000);

      deadline = callback;

      return mock();
    },
  });
  const closing = shutdown("SIGTERM");

  expect(shutdown("SIGINT")).toBe(closing);
  expect(app.close).toHaveBeenCalledTimes(1);

  deadline();

  expect(await closing).toBe("forced");
  expect(app.forceStopHttp).toHaveBeenCalledTimes(1);
  expect(complete.mock.calls).toEqual([["forced"]]);

  // A late failure is observed/logged, not an unhandled rejection or second exit.
  cleanup.reject(new Error("unconfirmed writer"));
  await Promise.resolve();

  expect(log).toHaveBeenCalledTimes(2);
  expect(complete).toHaveBeenCalledTimes(1);
});

test("unsafe cleanup is a failed shutdown, not graceful success", async () => {
  const complete = mock();
  const shutdown = createShutdown({
    app: {
      close: async () => {
        throw new Error("unsafe");
      },
      forceStopHttp: async () => {},
    },
    log: mock(),
    complete,
  });

  expect(await shutdown("SIGINT")).toBe("failed");
  expect(complete.mock.calls).toEqual([["failed"]]);
});
