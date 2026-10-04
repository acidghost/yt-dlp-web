type WatchProgress = { duration: number | null; positionSeconds: number };

export function fullyWatched({ duration, positionSeconds }: WatchProgress): boolean {
  return (
    duration !== null &&
    Number.isFinite(duration) &&
    duration > 0 &&
    Number.isFinite(positionSeconds) &&
    positionSeconds > 0 &&
    positionSeconds >= duration - 30
  );
}

export function resumePosition(progress: WatchProgress): number {
  return fullyWatched(progress) ? 0 : progress.positionSeconds;
}
