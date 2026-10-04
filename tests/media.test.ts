import { expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  canonicalVideoUrl,
  downloadFormat,
  downloadVideo,
  extractionFailure,
  InputError,
  readDownloadOutput,
} from "../app/media";

test("format selector requests copy-compatible H.264 video and AAC audio up to 720p", () => {
  expect(downloadFormat).toContain(
    "bv[ext=mp4][vcodec^=avc1][height<=720]+ba[ext=m4a][acodec^=mp4a]",
  );
  expect(downloadFormat).toContain("/b[ext=mp4]");
});

test("extraction errors distinguish proxy denial, unavailable formats, and YouTube bot checks", () => {
  expect(
    extractionFailure("ERROR: Sign in to confirm you’re not a bot.").message,
  ).toContain("bot check");
  expect(
    extractionFailure(
      "Tunnel connection failed: 403 Forbidden: host www.google.com:443 is not in the allowlist",
    ).message,
  ).toContain("www.google.com");
  expect(
    extractionFailure("ERROR: Requested format is not available").message,
  ).toContain("H.264/AAC");
  expect(extractionFailure("unknown failure").message).not.toContain(
    "unknown failure",
  );
});

test("accepts yt-dlp's absolute after_move filepath for a relative staging path, but rejects another file", async () => {
  const dir = join(
    process.cwd(),
    "tmp",
    `download-path-${crypto.randomUUID()}`,
  );
  const bin = join(dir, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(bin, "yt-dlp"),
    `#!/bin/sh
previous=""
for arg in "$@"; do
  if [ "$previous" = "--output" ]; then output="$arg"; fi
  previous="$arg"
done
mkdir -p "$(dirname "$output")"
printf 'fixture' > "$output"
absolute="$(cd "$(dirname "$output")" && pwd -P)/$(basename "$output")"
if [ "$FAKE_WRONG_PATH" = "1" ]; then absolute="$absolute.other"; fi
if [ "$FAKE_UPLOADER_ONLY" = "1" ]; then
  printf '{"title":"Fixture","duration":10,"uploader":"Fallback uploader","filepath":"%s"}\\n' "$absolute"
else
  printf '{"title":"Fixture","duration":10,"channel":"Fixture channel","filepath":"%s"}\\n' "$absolute"
fi
`,
    { mode: 0o755 },
  );
  const output = `tmp/${dir.split("/").at(-1)}/video.mp4`;
  const run = async (wrong: boolean, uploaderOnly = false) => {
    const proc = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
      import { downloadVideo } from "./app/media.ts";
      try {
        console.log(JSON.stringify(await downloadVideo("https://www.youtube.com/watch?v=abcdefghijk", ${JSON.stringify(output)})));
      } catch (error) {
        console.error(error.message);
        process.exit(1);
      }
    `,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          FAKE_WRONG_PATH: wrong ? "1" : "0",
          FAKE_UPLOADER_ONLY: uploaderOnly ? "1" : "0",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, code };
  };
  try {
    const ok = await run(false);
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.stdout)).toEqual({
      title: "Fixture",
      duration: 10,
      channel: "Fixture channel",
    });
    const fallback = await run(false, true);
    expect(fallback.code).toBe(0);
    expect(JSON.parse(fallback.stdout).channel).toBe("Fallback uploader");
    const bad = await run(true);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain(
      "yt-dlp did not create the expected MP4 file.",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("canonicalizes YouTube URLs but rejects local and arbitrary hosts", () => {
  expect(canonicalVideoUrl("https://youtu.be/abcdefghijk?t=30")).toBe(
    "https://www.youtube.com/watch?v=abcdefghijk",
  );
  for (const url of [
    "https://127.0.0.1/watch?v=abcdefghijk",
    "https://youtube.com.evil/watch?v=abcdefghijk",
    "http://www.youtube.com/watch?v=abcdefghijk",
    "https://youtu.be/short",
  ]) {
    expect(() => canonicalVideoUrl(url)).toThrow(InputError);
  }
});

test("download parses chunked phase-local progress without retaining an unbounded log", async () => {
  const dir = join(
    process.cwd(),
    "tmp",
    `download-progress-${crypto.randomUUID()}`,
  );
  const bin = join(dir, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(bin, "yt-dlp"),
    `#!${process.execPath}
const args = process.argv.slice(2);
const output = args[args.indexOf("--output") + 1];
// yt-dlp download progress uses stdout; postprocessor hooks use stderr.
const emit = (info, progress) => console.log("YTDLP_WEB_PROGRESS:" + JSON.stringify({phase:"download",info,progress}));
process.stdout.write("YTDLP_WEB_PRO");
await Bun.sleep(5);
console.log('GRESS:{"phase":"download","info":{"vcodec":"avc1","acodec":"none"},"progress":{"downloaded_bytes":50,"total_bytes_estimate":100,"speed":20}}');
emit({vcodec:"none",acodec:"mp4a"}, {downloaded_bytes:5,total_bytes:10,speed:null});
emit({vcodec:"avc1",acodec:"mp4a"}, {downloaded_bytes:7,total_bytes:null,speed:3});
emit({vcodec:"avc1",acodec:"none"}, {downloaded_bytes:-1,total_bytes:"NA",speed:"NaN"});
// Optional stdout chatter must not consume the metadata budget.
console.log("YTDLP_WEB_PROGRESS:not-json");
console.log("YTDLP_WEB_PROGRESS:" + "x".repeat(40000));
for (let i=0; i<120; i++) console.log("YTDLP_WEB_PROGRESS:" + "x".repeat(512));
console.error("x".repeat(40000));
console.error('YTDLP_WEB_PROGRESS:{"phase":"postprocess","progress":{"status":"started","postprocessor":"Merger"}}');
console.error('YTDLP_WEB_PROGRESS:{"phase":"postprocess","progress":{"status":"started","postprocessor":"MoveFiles"}}');
await Bun.write(output, "fixture");
console.log(JSON.stringify({title:"Fixture",duration:10,filepath:output}, null, 2));
`,
    { mode: 0o755 },
  );
  const proc = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
    import { downloadVideo } from "./app/media.ts";
    const progress = [];
    const video = await downloadVideo("https://youtu.be/abcdefghijk", ${JSON.stringify(join(dir, "video.mp4"))}, {
      signal: new AbortController().signal, onProgress: p => progress.push(p)
    });
    console.log(JSON.stringify({ video, progress }));
  `,
    ],
    {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.progress).toEqual([
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
    expect(result.video.title).toBe("Fixture");
  } finally {
    if (proc.exitCode === null) proc.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
});

test("cancel stops an owned download group, including a TERM-resistant child", async () => {
  const dir = join(
    process.cwd(),
    "tmp",
    `download-cancel-${crypto.randomUUID()}`,
  );
  const bin = join(dir, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(bin, "yt-dlp"),
    `#!/bin/sh
trap 'wait; exit' TERM
/bin/sh -c 'trap "" TERM; printf child-ready > "$CHILD_READY"; while true; do printf x >> "$CHILD_WRITES"; sleep 0.02; done' &
wait
`,
    { mode: 0o755 },
  );
  const ready = join(dir, "ready");
  const writes = join(dir, "writes");
  const proc = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
    import { downloadVideo } from "./app/media.ts";
    const controller = new AbortController();
    const promise = downloadVideo("https://youtu.be/abcdefghijk", ${JSON.stringify(join(dir, "video.mp4"))}, { signal: controller.signal, onProgress() {} });
    for (let i=0; !(await Bun.file(${JSON.stringify(ready)}).exists()) && i<100; i++) await Bun.sleep(10);
    controller.abort();
    try { await promise; process.exit(1); } catch (error) { console.log(error.name); }
  `,
    ],
    {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        CHILD_READY: ready,
        CHILD_WRITES: writes,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  try {
    const code = await Promise.race([
      proc.exited,
      Bun.sleep(4000).then(() => null),
    ]);
    expect(code).toBe(0);
    expect((await new Response(proc.stdout).text()).trim()).toBe("AbortError");
    expect(await new Response(proc.stderr).text()).toBe("");
    const before = Bun.file(writes).size;
    await Bun.sleep(100);
    expect(Bun.file(writes).size).toBe(before);
  } finally {
    if (proc.exitCode === null) proc.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
}, 6000);

test("an already-aborted download never spawns yt-dlp", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    downloadVideo("https://youtu.be/abcdefghijk", "tmp/not-started.mp4", {
      signal: controller.signal,
      onProgress() {},
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
});

test("metadata is byte-bounded while non-progress stdout remains strict JSON", async () => {
  // Exercise the stream boundary directly; enforcing a metadata limit must not
  // depend on whether this environment permits killing a subprocess group.
  const progress =
    'YTDLP_WEB_PROGRESS:{"phase":"download","info":{"vcodec":"avc1","acodec":"none"},"progress":{"downloaded_bytes":5}}\n';
  for (const metadata of [
    JSON.stringify({ title: "x".repeat(33_000) }),
    JSON.stringify(
      { title: "é".repeat(9_000), channel: "é".repeat(9_000) },
      null,
      2,
    ),
  ]) {
    const stream = new Response(progress + metadata).body;
    if (!stream) throw new Error("Missing fixture stream");
    await expect(
      readDownloadOutput(stream, undefined, undefined, true),
    ).rejects.toThrow("yt-dlp output exceeded the limit for this demo.");
  }
  const stream = new Response(
    `${progress}unexpected stdout\n{"title":"Fixture"}`,
  ).body;
  if (!stream) throw new Error("Missing fixture stream");
  const metadata = await readDownloadOutput(stream, undefined, undefined, true);
  expect(metadata).toBe('unexpected stdout\n{"title":"Fixture"}');
  expect(() => JSON.parse(metadata)).toThrow();
});
