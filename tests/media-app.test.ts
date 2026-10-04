import { expect, mock, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { downloadVideo } from "../app/media";
import { appFixture } from "./support/app";
import { deferred } from "./support/async";
import {
  cancelDownload,
  history,
  removeHistory,
  requestResolve,
  waitForSnapshot,
  watched,
} from "./support/http";
import { controlledProcess } from "./support/process";

let proc = controlledProcess();

let started = deferred<string>();

mock.module("../app/owned-process", () => ({
  startOwnedProcess: (command: readonly string[]) => {
    const output = command[command.indexOf("--output") + 1];
    if (!output) {
      throw new Error("Missing production output option");
    }

    started.resolve(output);

    return proc;
  },
}));

test("HTTP composes real media command/streams/metadata with staging, publication and SQLite", async () => {
  await using fixture = await appFixture();

  proc = controlledProcess();
  started = deferred<string>();

  const stopped = fixture.gate();
  const stopStarted = fixture.gate();

  proc.stop.mockImplementation(async () => {
    stopStarted.release();
    await stopped.promise;
  });

  const base = fixture.start({ download: downloadVideo }); // No Download double: real downloadVideo/runner.
  const response = await requestResolve(base);

  expect(response.status).toBe(202);

  const { jobToken } = await response.json();
  const path = await started.promise;

  await writeFile(path, "media fixture");
  proc.emitStdout(
    'YTDLP_WEB_PROGRESS:{"phase":"download","info":{"vcodec":"avc1","acodec":"mp4a"},"progress":{"downloaded_bytes":13,"total_bytes":13,"status":"finished"}}\n',
  );
  proc.emitStdout(
    JSON.stringify({
      filepath: path,
      title: "Real parsed title",
      duration: 120,
      uploader: "Real parsed uploader",
    }),
  );
  proc.exit();
  await stopStarted.promise;

  expect((await fetch(`${base}/api/stream/abcdefghijk`)).status).toBe(404);
  expect(await Bun.file(path).exists()).toBe(true);

  stopped.release();

  const ready = await waitForSnapshot(base, jobToken, "ready");

  expect(ready.video).toMatchObject({
    kind: "download",
    title: "Real parsed title",
    channel: "Real parsed uploader",
    duration: 120,
  });
  expect(await (await fetch(`${base}/api/stream/abcdefghijk`)).text()).toBe("media fixture");
  expect(await Bun.file(path).exists()).toBe(false);
  expect(await history(base)).toEqual([]);

  await watched(base, ready.video.id, ready.video.token);

  const rows = await history(base);

  expect(rows[0]).toMatchObject({
    title: "Real parsed title",
    mp4: { sizeBytes: 13 },
  });

  const restarted = await fixture.restart();

  expect(await history(restarted)).toEqual(rows);
});

test("HTTP cancellation keeps real media's staging until the external stop contract confirms cleanup", async () => {
  await using fixture = await appFixture();

  proc = controlledProcess();
  started = deferred<string>();

  const cleanup = fixture.gate();
  const stopStarted = fixture.gate();

  proc.stop.mockImplementation(async () => {
    proc.exit();
    stopStarted.release();
    await cleanup.promise;
  });

  const base = fixture.start({ download: downloadVideo });
  const { jobToken } = await (await requestResolve(base)).json();
  const path = await started.promise;

  await writeFile(path, "partial");

  expect((await cancelDownload(base, jobToken)).status).toBe(202);

  await stopStarted.promise;

  expect((await fetch(`${base}/api/downloads/${jobToken}`)).status).toBe(200);
  expect(await Bun.file(path).exists()).toBe(true);
  expect((await removeHistory(base, "abcdefghijk", true)).status).toBe(409);

  cleanup.release();
  await waitForSnapshot(base, jobToken, "canceled");

  expect(await Bun.file(path).exists()).toBe(false);
  expect(await Bun.file(`${dirname(path)}/video.mp4`).exists()).toBe(false);
  expect((await fetch(`${base}/api/stream/abcdefghijk`)).status).toBe(404);
  expect(await history(base)).toEqual([]);
  expect(proc.stop).toHaveBeenCalledTimes(1);
});
