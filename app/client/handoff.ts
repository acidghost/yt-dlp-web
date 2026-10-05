import { type Quality, QualitySchema, type SavedVariant, SavedVariantSchema } from "../protocol";

export type PlayerMode = "proxy" | "mp4";

export type Handoff =
  | {
      url: string;
      mode: PlayerMode;
      startSeconds?: number;
      quality?: Quality;
      savedVariant?: SavedVariant;
    }
  | { error: string }
  | null;

function timestampSeconds(value: string | null): number | undefined {
  if (!value) {
    return;
  }

  let seconds: number;
  if (/^\d+$/.test(value)) {
    seconds = Number(value);
  } else {
    const parts = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i.exec(value);
    if (!parts) {
      return;
    }

    seconds = Number(parts[1] ?? 0) * 3600 + Number(parts[2] ?? 0) * 60 + Number(parts[3] ?? 0);
  }

  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : undefined;
}

export function videoStartSeconds(value: string): number | undefined {
  try {
    const url = new URL(value);
    const query = url.searchParams;
    const fragment = new URLSearchParams(url.hash.slice(1));

    return (
      timestampSeconds(query.get("t")) ??
      timestampSeconds(query.get("start")) ??
      timestampSeconds(fragment.get("t")) ??
      timestampSeconds(fragment.get("start"))
    );
  } catch {
    return;
  }
}

export function parseHandoff(search: string): Handoff {
  const params = new URLSearchParams(search);
  if (!params.has("url")) {
    return params.has("mode") ||
      params.has("quality") ||
      params.has("savedVariant") ||
      params.has("t") ||
      params.has("start")
      ? { error: "Add a video URL to the link." }
      : null;
  }

  const mode = params.get("mode") ?? "proxy";
  if (mode !== "proxy" && mode !== "mp4") {
    return { error: "Unknown playback mode." };
  }

  const quality = params.has("quality") ? QualitySchema.safeParse(params.get("quality")) : null;
  if (quality && !quality.success) {
    return { error: "Unknown video quality." };
  }
  const savedVariant = params.has("savedVariant")
    ? SavedVariantSchema.safeParse(params.get("savedVariant"))
    : null;
  if (
    savedVariant &&
    (!savedVariant.success ||
      mode !== "mp4" ||
      (quality?.success && quality.data !== savedVariant.data))
  ) {
    return { error: "Invalid saved MP4 selection." };
  }

  const url = params.get("url") ?? "";

  try {
    if (new URL(url).protocol !== "https:") {
      throw new Error("Not HTTPS");
    }
  } catch {
    return { error: "Enter an HTTPS video URL." };
  }

  const startSeconds =
    timestampSeconds(params.get("t")) ??
    timestampSeconds(params.get("start")) ??
    videoStartSeconds(url);

  // Only the server decides whether this is a supported YouTube video URL.
  return {
    url,
    mode,
    ...(quality?.success ? { quality: quality.data } : {}),
    ...(savedVariant?.success ? { savedVariant: savedVariant.data } : {}),
    ...(startSeconds === undefined ? {} : { startSeconds }),
  };
}

export function handoffSearch(
  url: string,
  mode: PlayerMode,
  startSeconds?: number,
  options: { quality?: Quality; savedVariant?: SavedVariant } = {},
): string {
  const params = new URLSearchParams({ url, mode });
  if (options.quality !== undefined) {
    params.set("quality", options.quality);
  }
  if (options.savedVariant !== undefined) {
    params.set("savedVariant", options.savedVariant);
  }
  if (startSeconds !== undefined) {
    params.set("t", String(startSeconds));
  }

  return params.toString();
}

export function resolveKind(mode: PlayerMode): "proxy" | "download" {
  return mode === "proxy" ? "proxy" : "download";
}
