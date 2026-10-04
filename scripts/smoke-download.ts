// Exercise the real yt-dlp templates, ffmpeg merge, and group cancellation
// without network access. Only this fixture wrapper enables local file URLs.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const realYtDlp = Bun.which("yt-dlp");
if (!realYtDlp) throw new Error("Install yt-dlp on PATH first.");
const dir = await mkdtemp(join(tmpdir(), "yt-dlp-media-smoke-"));
const bin = join(dir, "bin");
let passed = false;
try {
  await mkdir(bin);
  const fixture = join(import.meta.dir, "../e2e/fixtures/player.mp4");
  for (const [name, flags] of [
    ["video.mp4", ["-an", "-c:v", "copy"]],
    ["audio.m4a", ["-vn", "-c:a", "copy"]],
  ] as const) {
    const ffmpeg = Bun.spawnSync([
      "ffmpeg",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      fixture,
      ...flags,
      join(dir, name),
    ]);
    assert.equal(ffmpeg.exitCode, 0, ffmpeg.stderr.toString());
  }
  const fixtureUrl = "https://www.youtube.com/watch?v=abcdefghijk";
  const info = join(dir, "info.json");
  const diagnostics = join(dir, "stderr");
  await writeFile(
    info,
    JSON.stringify({
      id: "abcdefghijk",
      title: "Local media fixture",
      duration: 10,
      is_live: false,
      extractor: "generic",
      extractor_key: "Generic",
      webpage_url: fixtureUrl,
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
  // Preserve the runner's production flags. Only replace URL extraction with
  // a local info fixture, and forward progress immediately, not at EOF.
  // --enable-file-urls is fixture-only: production keeps YouTube URL guards.
  await writeFile(
    join(bin, "yt-dlp"),
    `#!${process.execPath}
const args = process.argv.slice(2, -2);
const child = Bun.spawn([${JSON.stringify(realYtDlp)}, ...args, "--enable-file-urls", "--load-info-json", ${JSON.stringify(info)}], {stdout:"inherit",stderr:"pipe"});
let tail = "";
const decoder = new TextDecoder();
for await (const chunk of child.stderr) { process.stderr.write(chunk); tail = (tail + decoder.decode(chunk)).slice(-16000); }
await Bun.write(${JSON.stringify(diagnostics)}, tail);
process.exit(await child.exited);
`,
    { mode: 0o755 },
  );
  const runner = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
import assert from "node:assert/strict";
import { downloadVideo } from ${JSON.stringify(join(import.meta.dir, "../app/media.ts"))};
const controller = new AbortController();
const cancel = new AbortController();
const timer = setTimeout(() => { controller.abort(); cancel.abort(); }, 20000);
const progress = [];
try {
  const result = await downloadVideo("https://youtu.be/abcdefghijk", ${JSON.stringify(join(dir, "result.mp4"))}, {signal:controller.signal,onProgress:p=>progress.push(p)});
  assert.equal(result.title, "Local media fixture");
  assert(Bun.file(${JSON.stringify(join(dir, "result.mp4"))}).size > 0);
  const phases = new Set(progress.map(p => p.phase));
  for (const phase of ["video", "audio", "merging"]) assert(phases.has(phase), "Missing phase: " + phase);
  console.log("Real yt-dlp/ffmpeg download passed: progress, merge, and metadata.");
  await assert.rejects(downloadVideo("https://youtu.be/abcdefghijk", ${JSON.stringify(join(dir, "canceled.mp4"))}, {signal:cancel.signal,onProgress() { cancel.abort(); }}), {name:"AbortError"});
  console.log("Real yt-dlp/ffmpeg smoke passed: video → audio → merge; group cancellation confirmed.");
} finally { clearTimeout(timer); }
`,
    ],
    {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(runner.stdout).text(),
    new Response(runner.stderr).text(),
    runner.exited,
  ]);
  if (code !== 0) {
    if (stdout.trim()) console.error(stdout.trim());
    console.error(stderr);
    console.error(
      await Bun.file(diagnostics)
        .text()
        .catch(() => "No diagnostic tail available."),
    );
    throw new Error(`Media smoke failed (exit ${code}).`);
  }
  passed = true;
  console.log(stdout.trim());
} finally {
  if (passed) await rm(dir, { recursive: true, force: true });
  else
    console.error(
      `Kept smoke files at ${dir} for diagnosis. Stop any remaining processes before removing them.`,
    );
}
