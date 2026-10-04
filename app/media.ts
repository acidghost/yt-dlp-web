import { resolve } from "node:path";
import type { TransferProgress } from "./protocol";

export class InputError extends Error {}
// Cleanup is unsafe if a descendant might still be writing into staging.
export class DownloadTerminationError extends InputError {}

export type DownloadedVideo = {
  title: string;
  duration: number | null;
  channel: string | null;
};
export type DownloadOptions = {
  signal: AbortSignal;
  onProgress: (progress: TransferProgress) => void;
};
export type Download = (
  url: string,
  outputPath: string,
  options?: DownloadOptions,
) => Promise<DownloadedVideo>;

const videoId = /^[a-zA-Z0-9_-]{11}$/;
const youtubeHosts = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtu.be",
]);

// Prefer a browser-playable H.264 video + AAC audio, remuxed without re-encoding.
// A combined MP4 is the fallback when separate tracks are not available.
export const downloadFormat =
  "bv[ext=mp4][vcodec^=avc1][height<=720]+ba[ext=m4a][acodec^=mp4a]/b[ext=mp4][vcodec^=avc1][acodec^=mp4a][height<=720]";

// Flags shared by every yt-dlp invocation.
const commonArgs = [
  "--ignore-config",
  "--no-playlist",
  "--match-filters",
  "!is_live",
  "--no-warnings",
  "--socket-timeout",
  "15",
];

export function canonicalVideoUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048)
    throw new InputError("Enter a YouTube video URL.");

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InputError("Enter a valid YouTube video URL.");
  }

  if (
    url.protocol !== "https:" ||
    !youtubeHosts.has(url.hostname) ||
    url.port ||
    url.username ||
    url.password
  ) {
    throw new InputError("Only public HTTPS YouTube video URLs are supported.");
  }

  const id =
    url.hostname === "youtu.be"
      ? url.pathname.slice(1)
      : url.pathname === "/watch"
        ? url.searchParams.get("v")
        : /^\/(shorts|live)\//.test(url.pathname)
          ? url.pathname.split("/")[2]
          : null;
  if (!id || !videoId.test(id))
    throw new InputError(
      "Enter a single YouTube watch, short, or live video URL.",
    );

  return `https://www.youtube.com/watch?v=${id}`;
}

// Maps yt-dlp failure output to actionable messages.
export function extractionFailure(stderr: string): InputError {
  if (stderr.includes("Sign in to confirm")) {
    return new InputError(
      "YouTube requires sign-in or a bot check for this connection. This demo supports only public videos without authentication.",
    );
  }

  const blocked =
    /Forbidden: host ([a-z0-9.-]+):443 is not in the allowlist/i.exec(stderr);
  if (blocked)
    return new InputError(
      `The sandbox proxy blocked ${blocked[1]}. Add this host to its allowlist and retry.`,
    );

  if (/Requested format is not available/i.test(stderr)) {
    return new InputError(
      "No H.264/AAC MP4 formats are available for this video at or below 720p.",
    );
  }

  if (/ffmpeg not found/i.test(stderr))
    return new InputError(
      "ffmpeg is required to merge audio and video. Install it on PATH.",
    );

  return new InputError(
    "yt-dlp could not access this video. Check that it is public and yt-dlp is up to date.",
  );
}

// Reads a subprocess stream up to max bytes, then gives up.
async function readLimited(
  stream: ReadableStream<Uint8Array>,
  max: number,
  signal?: AbortSignal,
): Promise<string> {
  const reader = stream.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder();
  let total = 0;
  let result = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return result + decoder.decode();
      total += value.byteLength;
      if (total > max)
        throw new InputError("yt-dlp output exceeded the limit for this demo.");
      result += decoder.decode(value, { stream: true });
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

// Runs yt-dlp with bounded output and a kill timer. Throws the timeout
// message when the timer fired and extractionFailure(stderr) on a bad exit.
async function runYtDlp(
  args: string[],
  limits: { stdoutMax: number; timeoutMs: number; timeoutMessage: string },
): Promise<string> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(["yt-dlp", ...args], { stdout: "pipe", stderr: "pipe" });
  } catch {
    throw new InputError(
      "Could not start yt-dlp. Check that its binary is on PATH.",
    );
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, limits.timeoutMs);

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readLimited(proc.stdout as ReadableStream<Uint8Array>, limits.stdoutMax),
      readLimited(proc.stderr as ReadableStream<Uint8Array>, 16_000),
      proc.exited,
    ]);
    if (timedOut) throw new InputError(limits.timeoutMessage);
    if (exitCode !== 0) throw extractionFailure(stderr);
    return stdout;
  } finally {
    clearTimeout(timer);
    if (proc.exitCode === null) proc.kill();
  }
}

const progressPrefix = "YTDLP_WEB_PROGRESS:";
const emptyProgress = {
  downloadedBytes: null,
  totalBytes: null,
  totalEstimated: false,
  speedBytesPerSecond: null,
};

function progressRecord(line: string): TransferProgress | null {
  if (!line.startsWith(progressPrefix)) return null;
  try {
    const record = JSON.parse(line.slice(progressPrefix.length));
    if (record.phase === "postprocess")
      return {
        phase:
          record.progress?.postprocessor === "Merger"
            ? "merging"
            : "processing",
        ...emptyProgress,
      };
    if (record.phase !== "download" || !record.progress || !record.info)
      return null;
    const info = record.info;
    const data = record.progress;
    const number = (value: unknown): number | null =>
      typeof value === "number" && Number.isFinite(value) && value >= 0
        ? value
        : null;
    const exact = number(data.total_bytes);
    const estimate = number(data.total_bytes_estimate);
    const total = exact && exact > 0 ? exact : estimate;
    const hasVideo = typeof info.vcodec === "string" && info.vcodec !== "none";
    const hasAudio = typeof info.acodec === "string" && info.acodec !== "none";
    return {
      phase:
        hasVideo && !hasAudio
          ? "video"
          : hasAudio && !hasVideo
            ? "audio"
            : "mp4",
      downloadedBytes: number(data.downloaded_bytes),
      totalBytes: total && total > 0 ? total : null,
      totalEstimated: !(exact && exact > 0) && !!total,
      speedBytesPerSecond:
        data.status === "finished" ? null : number(data.speed),
    };
  } catch {
    return null; // Optional progress must never suppress valid final metadata.
  }
}

// yt-dlp sends download progress to stdout and postprocessor progress to stderr.
// Bound optional lines/tails, not aggregate progress. Only non-progress stdout
// counts toward the 32KB metadata limit; keep its pretty-printed JSON intact.
export async function readDownloadOutput(
  stream: ReadableStream<Uint8Array>,
  onProgress?: DownloadOptions["onProgress"],
  signal?: AbortSignal,
  collectMetadata = false,
): Promise<string> {
  const reader = stream.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder();
  let pending = "";
  let dropping = false;
  let tail = "";
  let metadata = "";
  let metadataBytes = 0;
  const finishLine = (newline: boolean) => {
    if (!dropping) {
      const line = pending.trim();
      if (line.startsWith(progressPrefix)) {
        const progress = progressRecord(line);
        if (progress) onProgress?.(progress);
      } else if (collectMetadata) {
        const text = pending + (newline ? "\n" : "");
        metadataBytes += Buffer.byteLength(text);
        if (metadataBytes > 32_000)
          throw new InputError(
            "yt-dlp output exceeded the limit for this demo.",
          );
        metadata += text;
      }
    }
    pending = "";
    dropping = false;
  };
  const consume = (text: string) => {
    tail = (tail + text).slice(-16_000);
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (!dropping) {
        const next = pending + line;
        const optional =
          !collectMetadata || next.trimStart().startsWith(progressPrefix);
        if (next.length > (optional ? 16_000 : 32_000)) {
          if (!optional)
            throw new InputError(
              "yt-dlp output exceeded the limit for this demo.",
            );
          pending = "";
          dropping = true;
        } else pending = next;
      }
      if (i < lines.length - 1) finishLine(true);
    }
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        consume(decoder.decode());
        if (pending || dropping) finishLine(false);
        return collectMetadata ? metadata : tail;
      }
      consume(decoder.decode(value, { stream: true }));
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

async function stopDownloadGroup(
  proc: ReturnType<typeof Bun.spawn>,
): Promise<void> {
  const signal = (value: NodeJS.Signals | 0): boolean => {
    try {
      process.kill(-proc.pid, value);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw new DownloadTerminationError(
        "Could not stop the download process group safely. Partial files may remain.",
      );
    }
  };
  const wait = async (ms: number): Promise<boolean> => {
    const deadline = Date.now() + ms;
    while (signal(0)) {
      if (Date.now() >= deadline) return false;
      await Bun.sleep(25);
    }
    return true;
  };
  if (signal("SIGTERM") && !(await wait(400))) {
    signal("SIGKILL");
    if (!(await wait(1_500)))
      throw new DownloadTerminationError(
        "Could not confirm download process cleanup. Partial files may remain.",
      );
  }
  await proc.exited;
}

// Separate from HLS extraction: own a process group so cancel and timeout also
// stop ffmpeg, and await termination before the server removes staging.
async function runDownload(
  args: string[],
  options?: DownloadOptions,
): Promise<string> {
  options?.signal.throwIfAborted();
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new InputError("MP4 downloads require macOS or Linux.");
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(["yt-dlp", ...args], {
      detached: true,
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    throw new InputError(
      "Could not start yt-dlp. Check that its binary is on PATH.",
    );
  }
  const reads = new AbortController();
  let rejectStop!: (error: unknown) => void;
  const stopFailed = new Promise<never>((_resolve, reject) => {
    rejectStop = reject;
  });
  let stopping: Promise<void> | undefined;
  const stop = () => {
    if (!stopping) {
      stopping = stopDownloadGroup(proc);
      void stopping.catch(rejectStop);
    }
  };
  options?.signal.addEventListener("abort", stop, { once: true });
  if (options?.signal.aborted) stop();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, 20 * 60_000);
  // Pipes have independent delivery order. Do not let a buffered transfer
  // sample regress the UI after postprocessing has already started.
  let postprocessing = false;
  const onProgress = (progress: TransferProgress) => {
    const processing =
      progress.phase === "merging" || progress.phase === "processing";
    if (postprocessing && !processing) return;
    postprocessing ||= processing;
    options?.onProgress(progress);
  };
  try {
    const [stdout, stderr, exitCode] = await Promise.race([
      Promise.all([
        readDownloadOutput(
          proc.stdout as ReadableStream<Uint8Array>,
          onProgress,
          reads.signal,
          true,
        ),
        readDownloadOutput(
          proc.stderr as ReadableStream<Uint8Array>,
          onProgress,
          reads.signal,
        ),
        proc.exited,
      ]),
      stopFailed,
    ]);
    options?.signal.throwIfAborted();
    if (timedOut)
      throw new InputError("The download timed out after 20 minutes.");
    if (exitCode !== 0) throw extractionFailure(stderr);
    return stdout;
  } finally {
    clearTimeout(timer);
    options?.signal.removeEventListener("abort", stop);
    stop();
    try {
      await stopping;
    } finally {
      reads.abort();
    }
  }
}

function parseJson<T>(stdout: string, invalidMessage: string): T {
  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new InputError(invalidMessage);
  }
}

// Title/duration normalization shared by both extractors.
function videoMeta(info: {
  title?: unknown;
  duration?: unknown;
}): Pick<DownloadedVideo, "title" | "duration"> {
  return {
    title: typeof info.title === "string" ? info.title : "Untitled video",
    duration: typeof info.duration === "number" ? info.duration : null,
  };
}

// Prefers the channel name, falling back to the uploader.
function channelName(info: {
  channel?: unknown;
  uploader?: unknown;
}): string | null {
  for (const value of [info.channel, info.uploader]) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

export const downloadVideo: Download = async (url, outputPath, options) => {
  const stdout = await runDownload(
    [
      ...commonArgs,
      "--quiet",
      "--progress",
      "--newline",
      "--progress-delta",
      "1",
      "--progress-template",
      'download:YTDLP_WEB_PROGRESS:{"phase":"download","info":%(info.{format_id,vcodec,acodec})j,"progress":%(progress.{status,downloaded_bytes,total_bytes,total_bytes_estimate,speed})j}',
      "--progress-template",
      'postprocess:YTDLP_WEB_PROGRESS:{"phase":"postprocess","progress":%(progress.{status,postprocessor})j}',
      "--format",
      downloadFormat,
      "--merge-output-format",
      "mp4",
      "--output",
      outputPath,
      "--print",
      "after_move:%(.{title,duration,filepath,channel,uploader})#j",
      "--",
      url,
    ],
    options,
  );

  if (!stdout.trim())
    throw new InputError("Live or unavailable videos are not supported.");

  const result = parseJson<{
    filepath?: unknown;
    title?: unknown;
    duration?: unknown;
    channel?: unknown;
    uploader?: unknown;
  }>(stdout, "yt-dlp returned invalid download metadata.");

  // yt-dlp reports after_move.filepath as an absolute path even when --output
  // was relative (e.g. DATA_DIR=./data). Keep rejecting a different file.
  if (
    typeof result.filepath !== "string" ||
    resolve(result.filepath) !== resolve(outputPath)
  )
    throw new InputError("yt-dlp did not create the expected MP4 file.");

  return { ...videoMeta(result), channel: channelName(result) };
};

export type HlsSource = {
  title: string;
  duration: number | null;
  channel: string | null;
  manifest: string;
  headers: Record<string, string>;
};
export type ExtractHls = (url: string) => Promise<HlsSource>;

// Print only selected fields: a full yt-dlp JSON dump includes megabytes of captions.
export const extractHls: ExtractHls = async (url) => {
  const stdout = await runYtDlp(
    [
      ...commonArgs,
      "--print",
      "%(.{title,duration,channel,uploader,formats})#j",
      "--",
      url,
    ],
    {
      stdoutMax: 2_000_000,
      timeoutMs: 60_000,
      timeoutMessage: "The extraction timed out after 60 seconds.",
    },
  );

  const info = parseJson<{
    title?: unknown;
    duration?: unknown;
    channel?: unknown;
    uploader?: unknown;
    formats?: Array<{
      protocol?: string;
      vcodec?: string;
      height?: number;
      manifest_url?: string;
      http_headers?: Record<string, string>;
    }>;
  }>(stdout, "yt-dlp returned invalid HLS metadata.");

  // Best H.264 HLS rendition at or below 720p.
  const chosen = info.formats
    ?.filter(
      (f) =>
        f.protocol === "m3u8_native" &&
        f.vcodec?.startsWith("avc1") &&
        typeof f.height === "number" &&
        f.height <= 720 &&
        typeof f.manifest_url === "string",
    )
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0))[0];
  if (!chosen?.manifest_url)
    throw new InputError(
      "No H.264 HLS playlist is available for this video at or below 720p. Select a download mode instead.",
    );

  // Only forward the headers YouTube's CDN actually needs.
  const headers: Record<string, string> = {};
  for (const name of ["User-Agent", "Accept", "Accept-Language", "Referer"]) {
    const value = chosen.http_headers?.[name];
    if (typeof value === "string") headers[name] = value;
  }

  return {
    ...videoMeta(info),
    channel: channelName(info),
    manifest: chosen.manifest_url,
    headers,
  };
};
