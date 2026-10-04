import { beforeAll, expect, mock, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { DownloadTerminationError, downloadVideo } from "../../app/media";
import { startOwnedProcess } from "../../app/owned-process";
import type { TransferProgress } from "../../app/protocol";

// Capture the actual function value BEFORE overriding its live module export.
const launchReal = startOwnedProcess;
const url = "https://www.youtube.com/watch?v=abcdefghijk";
mock.module("../../app/owned-process", () => ({
  startOwnedProcess: (command: readonly string[]) => {
    expect(command[0]).toBe("yt-dlp");
    expect(command.slice(-2)).toEqual(["--", url]);
    const output = command[command.indexOf("--output") + 1];
    if (!output) throw new Error("Missing production output option");
    // Each operation owns its source alongside its output; no case-global input.
    const info = join(dirname(output), "input.json");
    // Adapt only source extraction. Every production output/progress/format
    // option is retained; neither the app nor PATH knows about this fixture.
    return launchReal([
      ...command.slice(0, -2),
      "--enable-file-urls",
      "--load-info-json",
      info,
    ]);
  },
}));

beforeAll(async () => {
  for (const tool of ["yt-dlp", "ffmpeg", "ffprobe"])
    if (!Bun.which(tool))
      throw new Error(`Install ${tool} on PATH to run test-media-tools.`);
});

async function localInput(dir: string, repeat: number) {
  for (const [track, flags] of [
    ["video.mp4", ["-an", "-c:v", "copy"]],
    ["audio.m4a", ["-vn", "-c:a", "copy"]],
  ] as const) {
    const result = Bun.spawnSync([
      "ffmpeg",
      "-hide_banner",
      "-loglevel",
      "error",
      "-stream_loop",
      String(repeat),
      "-i",
      join(import.meta.dir, "../../e2e/fixtures/player.mp4"),
      ...flags,
      join(dir, track),
    ]);
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
  }
  const path = join(dir, "input.json");
  await writeFile(
    path,
    JSON.stringify({
      id: "abcdefghijk",
      title: "Local media fixture",
      duration: 12 * (repeat + 1),
      is_live: false,
      extractor: "generic",
      extractor_key: "Generic",
      webpage_url: url,
      formats: [
        {
          format_id: "video",
          url: pathToFileURL(join(dir, "video.mp4")).href,
          ext: "mp4",
          protocol: "http",
          vcodec: "avc1.4d401e",
          acodec: "none",
          height: 360,
          width: 640,
        },
        {
          format_id: "audio",
          url: pathToFileURL(join(dir, "audio.m4a")).href,
          ext: "m4a",
          protocol: "http",
          vcodec: "none",
          acodec: "mp4a.40.2",
        },
      ],
    }),
  );
  return path;
}

async function mediaFixture(repeat: number) {
  const dir = await mkdtemp(join(tmpdir(), "media-tools-"));
  try {
    await localInput(dir, repeat);
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  const path = join(dir, "result.mp4");
  let unsafe = false;
  return {
    path,
    async download(
      onProgress: (value: TransferProgress) => void,
      controller: AbortController,
    ) {
      const timer = setTimeout(() => controller.abort(), 20_000);
      try {
        return await downloadVideo(url, path, {
          signal: controller.signal,
          onProgress,
        });
      } catch (error) {
        if (error instanceof DownloadTerminationError) {
          unsafe = true;
          console.error("Unconfirmed termination cause:", error.cause);
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
    async [Symbol.asyncDispose]() {
      if (unsafe)
        console.error(
          `Kept ${dir}; confirm remaining writers stopped before removing it.`,
        );
      else await rm(dir, { recursive: true, force: true });
    },
  };
}

test("real yt-dlp/ffmpeg templates report video/audio/Merger and return usable H.264/AAC MP4 metadata", async () => {
  await using fixture = await mediaFixture(0);
  const path = fixture.path;
  const progress: TransferProgress[] = [];
  const video = await fixture.download(
    (value) => progress.push(value),
    new AbortController(),
  );
  expect(video).toMatchObject({ title: "Local media fixture", duration: 12 });
  expect(Bun.file(path).size).toBeGreaterThan(0);
  const phases = new Set(progress.map((value) => value.phase));
  for (const phase of ["video", "audio", "merging"] as const)
    expect(phases.has(phase)).toBe(true);
  const probe = Bun.spawnSync([
    "ffprobe",
    "-v",
    "error",
    "-show_entries",
    "stream=codec_name",
    "-of",
    "json",
    path,
  ]);
  expect(probe.exitCode).toBe(0);
  expect(
    JSON.parse(probe.stdout.toString())
      .streams.map((stream: { codec_name: string }) => stream.codec_name)
      .sort(),
  ).toEqual(["aac", "h264"]);
}, 30_000);

test("real downloader cancellation confirms owned process termination after observed transfer", async () => {
  await using fixture = await mediaFixture(9);
  const controller = new AbortController();
  let observedTransfer = false;
  const result = fixture.download((value) => {
    if (value.phase === "video") {
      observedTransfer = true;
      controller.abort();
    }
  }, controller);
  await expect(result).rejects.toMatchObject({ name: "AbortError" });
  expect(observedTransfer).toBe(true);
}, 30_000);
