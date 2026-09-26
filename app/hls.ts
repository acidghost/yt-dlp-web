import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { InputError } from "./media";

export type PackageHls = (mp4: string, dir: string) => Promise<void>;

export const packageHls: PackageHls = async (mp4, dir) => {
  await mkdir(dir, { recursive: true });

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(
      [
        "ffmpeg",
        "-nostdin",
        "-loglevel",
        "error",
        "-i",
        mp4,
        "-map",
        "0:v:0",
        "-map",
        "0:a:0",
        "-c",
        "copy",
        "-f",
        "hls",
        "-hls_time",
        "6",
        "-hls_playlist_type",
        "vod",
        "-hls_segment_filename",
        join(dir, "%04d.ts"),
        join(dir, "index.m3u8"),
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
  } catch {
    throw new InputError("Could not start ffmpeg. Check that it is on PATH.");
  }
  const timer = setTimeout(() => proc.kill(), 20 * 60_000);
  try {
    if (
      (await proc.exited) !== 0 ||
      !(await Bun.file(join(dir, "index.m3u8")).exists())
    ) {
      throw new InputError(
        "ffmpeg could not package this MP4 as HLS. The downloaded MP4 remains available.",
      );
    }
  } finally {
    clearTimeout(timer);
    if (proc.exitCode === null) proc.kill();
  }
};
