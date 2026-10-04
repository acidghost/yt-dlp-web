import type { DownloadOptions } from "./media";
import { extractionFailure, InputError } from "./media-errors";
import { startOwnedProcess } from "./owned-process";
import type { TransferProgress } from "./protocol";

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
export async function runExtraction(
  args: string[],
  limits: { stdoutMax: number; timeoutMs: number; timeoutMessage: string },
): Promise<string> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(["yt-dlp", ...args], { stdout: "pipe", stderr: "pipe" });
  } catch (error) {
    throw new InputError(
      "Could not start yt-dlp. Check that its binary is on PATH.",
      { cause: error },
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
async function readDownloadOutput(
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

// Separate from HLS extraction: own a process group so cancel and timeout also
// stop ffmpeg, and await termination before the server removes staging.
export async function runDownload(
  args: string[],
  options?: DownloadOptions,
): Promise<string> {
  options?.signal.throwIfAborted();
  let proc: ReturnType<typeof startOwnedProcess>;
  try {
    proc = startOwnedProcess(["yt-dlp", ...args]);
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError(
      "Could not start yt-dlp. Check that its binary is on PATH.",
      { cause: error },
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
      stopping = proc.stop();
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
