import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";
import { resolve } from "node:path";
import {
  canonicalVideoUrl,
  DownloadTerminationError,
  downloadVideo,
  extractHls,
  InputError,
} from "../app/media";
import type { TransferProgress } from "../app/protocol";
import { deferred, waitFor } from "./support/async";
import { controlledProcess } from "./support/process";

const url = "https://www.youtube.com/watch?v=abcdefghijk";
const output = "tmp/media-fixture/video.mp4";
const active = new Set<Promise<unknown>>();
function observe<T>(promise: Promise<T>): Promise<T> {
  active.add(promise);
  void promise.catch(() => {});
  return promise;
}
let proc = controlledProcess();
let command: readonly string[] = [];
const launch = mock((argv: readonly string[]) => {
  command = argv;
  return proc;
});
mock.module("../app/owned-process", () => ({ startOwnedProcess: launch }));
const spawn = spyOn(Bun, "spawn").mockImplementation(
  () => proc as unknown as ReturnType<typeof Bun.spawn>,
);
afterAll(() => spawn.mockRestore());
afterEach(async () => {
  proc.exit();
  await Promise.allSettled(active);
  active.clear();
  launch.mockClear();
  command = [];
  proc = controlledProcess();
});

const metadata = (value = {}) =>
  JSON.stringify(
    {
      title: "Fixture",
      duration: 10,
      channel: "Channel",
      filepath: resolve(output),
      ...value,
    },
    null,
    2,
  );
const sample = (info: object, progress: object) =>
  `YTDLP_WEB_PROGRESS:${JSON.stringify({ phase: "download", info, progress })}\n`;
const processing = (postprocessor: string) =>
  `YTDLP_WEB_PROGRESS:${JSON.stringify({ phase: "postprocess", progress: { postprocessor } })}\n`;
function run(
  progress: TransferProgress[] = [],
  signal = new AbortController().signal,
) {
  return observe(
    downloadVideo(url, output, {
      signal,
      onProgress: (value) => progress.push(value),
    }),
  );
}

test("real download accepts absolute after_move path, normalizes metadata, and sends production command policy", async () => {
  const result = run();
  proc.emitStdout(metadata());
  proc.exit();
  expect(await result).toEqual({
    title: "Fixture",
    duration: 10,
    channel: "Channel",
  });
  const args = [...command];
  expect(args[0]).toBe("yt-dlp");
  expect(args.slice(-2)).toEqual(["--", url]);
  expect(args[args.indexOf("--output") + 1]).toBe(output);
  expect(args[args.indexOf("--format") + 1]).toContain(
    "bv[ext=mp4][vcodec^=avc1][height<=720]+ba[ext=m4a][acodec^=mp4a]",
  );
  expect(args[args.indexOf("--format") + 1]).toContain("/b[ext=mp4]");
  expect(args).toContain("--ignore-config");
  expect(args).toContain("--merge-output-format");
  expect(
    args.filter(
      (a) =>
        a.startsWith("download:YTDLP_WEB_PROGRESS:") ||
        a.startsWith("postprocess:YTDLP_WEB_PROGRESS:"),
    ),
  ).toHaveLength(2);
  expect(proc.stop).toHaveBeenCalledTimes(1);
});

for (const [value, expected] of [
  [
    { channel: " ", uploader: "Uploader" },
    { title: "Fixture", duration: 10, channel: "Uploader" },
  ],
  [
    { channel: null, title: null, duration: "10" },
    { title: "Untitled video", duration: null, channel: null },
  ],
] as const) {
  test(`normalizes tool metadata through downloadVideo: ${JSON.stringify(value)}`, async () => {
    const result = run();
    proc.emitStdout(metadata(value));
    proc.exit();
    expect(await result).toEqual(expected);
  });
}

for (const [text, message] of [
  [metadata({ filepath: `${output}.other` }), "expected MP4"],
  ["", "Live or unavailable"],
  [`unexpected stdout\n${metadata()}`, "invalid download metadata"],
  ["{broken", "invalid download metadata"],
  [metadata({ title: "x".repeat(33_000) }), "output exceeded"],
  [
    metadata({ title: "é".repeat(9_000), channel: "é".repeat(9_000) }),
    "output exceeded",
  ],
] as const) {
  test(`rejects unsafe/invalid download output: ${message} (${text.length} chars)`, async () => {
    const result = run();
    proc.emitStdout(text);
    proc.exit();
    await expect(result).rejects.toThrow(message);
    expect(proc.stop).toHaveBeenCalledTimes(1);
  });
}

test("stdout transfer progress and stderr postprocessors compose with chunked UTF-8/CRLF/final metadata", async () => {
  const progress: TransferProgress[] = [];
  const result = run(progress);
  const bytes = new TextEncoder().encode(
    sample(
      { vcodec: "avc1", acodec: "none" },
      { downloaded_bytes: 50, total_bytes_estimate: 100, speed: 20 },
    ) +
      sample(
        { vcodec: "none", acodec: "mp4a" },
        { downloaded_bytes: 5, total_bytes: 10, speed: 30, status: "finished" },
      ) +
      sample(
        { vcodec: "avc1", acodec: "mp4a" },
        { downloaded_bytes: 7, speed: 3 },
      ) +
      sample(
        { vcodec: "avc1", acodec: "none" },
        { downloaded_bytes: -1, total_bytes: "NA", speed: "NaN" },
      ) +
      "YTDLP_WEB_PROGRESS:not-json\n" +
      "YTDLP_WEB_PROGRESS:" +
      "x".repeat(40_000) +
      "\n" +
      `YTDLP_WEB_PROGRESS:${"x".repeat(512)}\n`.repeat(120),
  );
  for (let offset = 0; offset < bytes.length; offset += 13)
    proc.emitStdout(bytes.slice(offset, offset + 13));
  await waitFor(
    async () => progress.length,
    (count) => count === 4,
    "four transfer samples",
  );
  proc.emitStderr(
    `${"x".repeat(40_000)}\n${processing("Merger")}${processing("MoveFiles")}`,
  );
  await waitFor(
    async () => progress.length,
    (count) => count === 6,
    "postprocessor samples",
  );
  // A buffered transfer on the other pipe must not regress postprocessing.
  proc.emitStdout(
    sample({ vcodec: "avc1", acodec: "none" }, { downloaded_bytes: 1 }),
  );
  const final = new TextEncoder().encode(
    metadata({ title: "Café" }).replaceAll("\n", "\r\n"),
  );
  for (const byte of final) proc.emitStdout(new Uint8Array([byte]));
  proc.exit();
  expect((await result).title).toBe("Café");
  expect(progress).toEqual([
    {
      phase: "video",
      downloadedBytes: 50,
      totalBytes: 100,
      totalEstimated: true,
      speedBytesPerSecond: 20,
    },
    {
      phase: "audio",
      downloadedBytes: 5,
      totalBytes: 10,
      totalEstimated: false,
      speedBytesPerSecond: null,
    },
    {
      phase: "mp4",
      downloadedBytes: 7,
      totalBytes: null,
      totalEstimated: false,
      speedBytesPerSecond: 3,
    },
    {
      phase: "video",
      downloadedBytes: null,
      totalBytes: null,
      totalEstimated: false,
      speedBytesPerSecond: null,
    },
    {
      phase: "merging",
      downloadedBytes: null,
      totalBytes: null,
      totalEstimated: false,
      speedBytesPerSecond: null,
    },
    {
      phase: "processing",
      downloadedBytes: null,
      totalBytes: null,
      totalEstimated: false,
      speedBytesPerSecond: null,
    },
  ]);
});

for (const [stderr, message] of [
  ["ERROR: Sign in to confirm you're not a bot", "bot check"],
  [
    "403 Forbidden: host www.google.com:443 is not in the allowlist",
    "www.google.com",
  ],
  ["Requested format is not available", "H.264/AAC"],
  ["ffmpeg not found", "ffmpeg is required"],
  ["private tool failure and URL", "yt-dlp could not access"],
]) {
  test(`maps external failure safely: ${message}`, async () => {
    const result = run();
    proc.emitStderr(`${"x".repeat(40_000)}\n${stderr}`);
    proc.exit(1);
    await expect(result).rejects.toThrow(message);
  });
}

test("abort triggers one stop and does not complete before safe cleanup", async () => {
  const controller = new AbortController();
  const cleanup = deferred();
  proc.stop.mockImplementation(async () => {
    proc.exit();
    await cleanup.promise;
  });
  let settled = false;
  const result = run([], controller.signal).finally(() => {
    settled = true;
  });
  // Observe rejection immediately, even if an assertion fails before release.
  void result.catch(() => {});
  try {
    controller.abort();
    await Promise.resolve();
    expect(proc.stop).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
  } finally {
    cleanup.resolve();
  }
  await expect(result).rejects.toMatchObject({ name: "AbortError" });
});

test("already-aborted never launches; spawn error retains cause", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(run([], controller.signal)).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(launch).not.toHaveBeenCalled();
  const cause = new Error("ENOENT");
  launch.mockImplementationOnce(() => {
    throw cause;
  });
  await expect(run()).rejects.toMatchObject({
    cause,
    message: "Could not start yt-dlp. Check that its binary is on PATH.",
  });
});

test("pipe failure still awaits stop; unconfirmed cleanup overrides cancellation", async () => {
  const controller = new AbortController();
  const cause = new Error("EPERM");
  proc.stop.mockRejectedValue(
    new DownloadTerminationError("Unsafe cleanup", { cause }),
  );
  const result = run([], controller.signal);
  controller.abort();
  await expect(result).rejects.toMatchObject({
    cause,
    message: "Unsafe cleanup",
  });
  expect(proc.stop).toHaveBeenCalledTimes(1);
  proc.exit();
  proc = controlledProcess();
  const failed = run();
  proc.failStdout(new Error("Broken pipe"));
  await expect(failed).rejects.toThrow("Broken pipe");
  expect(proc.stop).toHaveBeenCalledTimes(1);
});

test("HLS extraction selects best compatible rendition and only forwards permitted headers", async () => {
  const result = observe(extractHls(url));
  proc.emitStdout(
    JSON.stringify({
      title: "HLS",
      duration: 20,
      uploader: "Fallback",
      formats: [
        {
          protocol: "m3u8_native",
          vcodec: "avc1",
          height: 360,
          manifest_url: "https://manifest.googlevideo.com/360.m3u8",
        },
        {
          protocol: "m3u8_native",
          vcodec: "avc1",
          height: 720,
          manifest_url: "https://manifest.googlevideo.com/720.m3u8",
          http_headers: { "User-Agent": "fixture", Cookie: "secret" },
        },
        {
          protocol: "m3u8_native",
          vcodec: "avc1",
          height: 1080,
          manifest_url: "wrong",
        },
        {
          protocol: "m3u8_native",
          vcodec: "vp9",
          height: 720,
          manifest_url: "wrong",
        },
      ],
    }),
  );
  proc.exit();
  expect(await result).toEqual({
    title: "HLS",
    duration: 20,
    channel: "Fallback",
    manifest: "https://manifest.googlevideo.com/720.m3u8",
    headers: { "User-Agent": "fixture" },
  });
  expect(spawn).toHaveBeenCalled();
});

for (const [text, message] of [
  ["{bad", "invalid HLS metadata"],
  ["{}", "No H.264 HLS"],
  ["x".repeat(2_000_001), "output exceeded"],
]) {
  test(`HLS extraction rejects ${message}`, async () => {
    const result = observe(extractHls(url));
    proc.emitStdout(text ?? "");
    proc.exit();
    await expect(result).rejects.toThrow(message ?? "");
  });
}

test("canonicalizes only single public HTTPS YouTube videos", () => {
  expect(canonicalVideoUrl("https://youtu.be/abcdefghijk?t=30")).toBe(url);
  for (const bad of [
    "https://127.0.0.1/watch?v=abcdefghijk",
    "https://youtube.com.evil/watch?v=abcdefghijk",
    "http://www.youtube.com/watch?v=abcdefghijk",
    "https://youtu.be/short",
    "https://evil@www.youtube.com/watch?v=abcdefghijk",
    "https://www.youtube.com/playlist?list=abc",
  ])
    expect(() => canonicalVideoUrl(bad)).toThrow(InputError);
});

for (const mode of ["download", "extraction"] as const) {
  test(`${mode} timeout uses its own budget and stops the external process`, async () => {
    const realSetTimeout = setTimeout;
    let deadline!: () => void;
    let budget = 0;
    const timer = spyOn(globalThis, "setTimeout").mockImplementationOnce(((
      callback: () => void,
      ms?: number,
    ) => {
      deadline = callback as () => void;
      budget = ms ?? 0;
      return realSetTimeout(() => {}, 60_000);
    }) as typeof setTimeout);
    const result = mode === "download" ? run() : observe(extractHls(url));
    void result.catch(() => {});
    try {
      expect(budget).toBe(mode === "download" ? 20 * 60_000 : 60_000);
      deadline();
      await expect(result).rejects.toThrow("timed out");
      expect(mode === "download" ? proc.stop : proc.kill).toHaveBeenCalledTimes(
        1,
      );
    } finally {
      proc.exit();
      await result.catch(() => {});
      timer.mockRestore();
    }
  });
}
