import { expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  canonicalVideoUrl,
  downloadFormat,
  extractionFailure,
  InputError,
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
