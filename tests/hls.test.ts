import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageHls } from "../app/hls";

test("ffmpeg packages an H.264/AAC MP4 into a VOD playlist and TS segment", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yt-dlp-web-hls-"));
  try {
    const mp4 = join(dir, "video.mp4");
    const proc = Bun.spawn(
      [
        "ffmpeg",
        "-nostdin",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=160x90:r=10:d=1",
        "-f",
        "lavfi",
        "-i",
        "sine=duration=1",
        "-c:v",
        "libx264",
        "-c:a",
        "aac",
        "-shortest",
        mp4,
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    expect(await proc.exited).toBe(0);
    const output = join(dir, "hls");
    await packageHls(mp4, output);
    const playlist = await Bun.file(join(output, "index.m3u8")).text();
    expect(playlist).toContain("#EXT-X-ENDLIST");
    expect(playlist).toContain("0000.ts");
    const segment = Bun.file(join(output, "0000.ts"));
    expect(segment.size).toBeGreaterThan(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
