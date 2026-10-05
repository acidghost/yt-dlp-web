export class InputError extends Error {}
export class FormatUnavailableError extends InputError {}

// Cleanup is unsafe if a descendant might still be writing into staging.
export class DownloadTerminationError extends InputError {}

// Maps yt-dlp failure output to actionable messages.
export function extractionFailure(stderr: string): InputError {
  if (stderr.includes("Sign in to confirm")) {
    return new InputError(
      "YouTube requires sign-in or a bot check for this connection. This demo supports only public videos without authentication.",
    );
  }

  const blocked = /Forbidden: host ([a-z0-9.-]+):443 is not in the allowlist/i.exec(stderr);
  if (blocked) {
    return new InputError(
      `The sandbox proxy blocked ${blocked[1]}. Add this host to its allowlist and retry.`,
    );
  }

  if (/Requested format is not available/i.test(stderr)) {
    return new FormatUnavailableError("No compatible MP4 formats are available.");
  }

  if (/ffmpeg not found/i.test(stderr)) {
    return new InputError("ffmpeg is required to merge audio and video. Install it on PATH.");
  }

  return new InputError(
    "yt-dlp could not access this video. Check that it is public and yt-dlp is up to date.",
  );
}
