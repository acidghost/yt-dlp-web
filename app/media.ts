import { resolve } from "node:path";
import { FormatUnavailableError, InputError } from "./media-errors";
import { runDownload, runExtraction } from "./media-process";
import type { Quality, TransferProgress } from "./protocol";
import { qualityHeight, qualityLabel } from "./quality";

export { DownloadTerminationError, InputError } from "./media-errors";

export type DownloadedVideo = {
  title: string;
  duration: number | null;
  channel: string | null;
  height?: number | null;
};

export type DownloadOptions = {
  quality?: Quality;
  signal: AbortSignal;
  onProgress: (progress: TransferProgress) => void;
};

export type Download = (
  url: string,
  outputPath: string,
  options?: DownloadOptions,
) => Promise<DownloadedVideo>;

const videoId = /^[a-zA-Z0-9_-]{11}$/;

const youtubeHosts = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"]);

// Prefer H.264 + AAC, remuxed without re-encoding; combined MP4 is the fallback.
function downloadFormat(quality: Quality): string {
  const cap = qualityHeight(quality);
  const height = cap === null ? "" : `[height<=${cap}]`;
  return `bv[ext=mp4][vcodec^=avc1]${height}+ba[ext=m4a][acodec^=mp4a]/b[ext=mp4][vcodec^=avc1][acodec^=mp4a]${height}`;
}

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
  if (typeof value !== "string" || value.length > 2048) {
    throw new InputError("Enter a YouTube video URL.");
  }

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
  if (!id || !videoId.test(id)) {
    throw new InputError("Enter a single YouTube watch, short, or live video URL.");
  }

  return `https://www.youtube.com/watch?v=${id}`;
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
function channelName(info: { channel?: unknown; uploader?: unknown }): string | null {
  for (const value of [info.channel, info.uploader]) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  return null;
}

export const downloadVideo: Download = async (url, outputPath, options) => {
  const quality = options?.quality ?? "720";
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
      downloadFormat(quality),
      "--merge-output-format",
      "mp4",
      "--output",
      outputPath,
      "--print",
      "after_move:%(.{title,duration,filepath,channel,uploader,height})#j",
      "--",
      url,
    ],
    options,
  ).catch((error) => {
    if (error instanceof FormatUnavailableError) {
      const hint = quality === "best" ? "Try Stream (HLS)." : "Try a higher limit or Stream (HLS).";
      throw new InputError(
        `No H.264/AAC MP4 formats are available (${qualityLabel(quality)}). ${hint}`,
      );
    }
    throw error;
  });

  if (!stdout.trim()) {
    throw new InputError("Live or unavailable videos are not supported.");
  }

  const result = parseJson<{
    filepath?: unknown;
    height?: unknown;
    title?: unknown;
    duration?: unknown;
    channel?: unknown;
    uploader?: unknown;
  }>(stdout, "yt-dlp returned invalid download metadata.");

  // yt-dlp reports after_move.filepath as an absolute path even when --output
  // was relative (e.g. DATA_DIR=./data). Keep rejecting a different file.
  if (typeof result.filepath !== "string" || resolve(result.filepath) !== resolve(outputPath)) {
    throw new InputError("yt-dlp did not create the expected MP4 file.");
  }

  const height =
    typeof result.height === "number" && Number.isSafeInteger(result.height) && result.height > 0
      ? result.height
      : null;
  const cap = qualityHeight(quality);
  if (cap !== null && height !== null && height > cap) {
    throw new InputError("Downloaded video exceeds the requested quality limit.");
  }
  return { ...videoMeta(result), channel: channelName(result), height };
};

export type HlsSource = {
  title: string;
  duration: number | null;
  channel: string | null;
  manifest: string;
  headers: Record<string, string>;
};

export type ExtractHls = (url: string, quality?: Quality) => Promise<HlsSource>;

// Print only selected fields: a full yt-dlp JSON dump includes megabytes of captions.
export const extractHls: ExtractHls = async (url, quality = "720") => {
  const cap = qualityHeight(quality);
  const stdout = await runExtraction(
    [...commonArgs, "--print", "%(.{title,duration,channel,uploader,formats})#j", "--", url],
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

  // Choose compatible source metadata; ProxySession also caps the actual master.
  const chosen = info.formats
    ?.filter(
      (f) =>
        f.protocol === "m3u8_native" &&
        f.vcodec?.startsWith("avc1") &&
        typeof f.height === "number" &&
        Number.isSafeInteger(f.height) &&
        f.height > 0 &&
        (cap === null || f.height <= cap) &&
        typeof f.manifest_url === "string",
    )
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0))[0];
  if (!chosen?.manifest_url) {
    const hint = quality === "best" ? "Choose Save MP4." : "Try a higher limit or choose Save MP4.";
    throw new InputError(`No H.264 HLS playlist is available (${qualityLabel(quality)}). ${hint}`);
  }

  // Only forward the headers YouTube's CDN actually needs.
  const headers: Record<string, string> = {};

  for (const name of ["User-Agent", "Accept", "Accept-Language", "Referer"]) {
    const value = chosen.http_headers?.[name];
    if (typeof value === "string") {
      headers[name] = value;
    }
  }

  return {
    ...videoMeta(info),
    channel: channelName(info),
    manifest: chosen.manifest_url,
    headers,
  };
};
