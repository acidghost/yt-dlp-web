// Return whether the key was handled so callers can leave other browser shortcuts alone.
export function controlPlayer(
  player: HTMLVideoElement,
  event: KeyboardEvent,
  toggleFullscreen?: () => void,
): boolean {
  const seek = (seconds: number): boolean => {
    const range = player.seekable;
    const start = range.length ? range.start(0) : 0;
    const end = range.length ? range.end(range.length - 1) : player.duration;
    if (!Number.isFinite(end) || !Number.isFinite(player.currentTime))
      return false;
    player.currentTime = Math.max(
      start,
      Math.min(end, player.currentTime + seconds),
    );
    return true;
  };

  switch (event.key) {
    case " ":
    case "k":
    case "K":
      if (!event.repeat) {
        if (player.paused) void player.play().catch(() => {});
        else player.pause();
      }
      return true;
    case "ArrowLeft":
      return seek(-5);
    case "ArrowRight":
      return seek(5);
    case "j":
    case "J":
      return seek(-10);
    case "l":
    case "L":
      return seek(10);
    case "<":
      player.playbackRate = Math.max(0.25, player.playbackRate - 0.25);
      return true;
    case ">":
      player.playbackRate = Math.min(2, player.playbackRate + 0.25);
      return true;
    case "f":
    case "F":
      if (!toggleFullscreen) return false;
      if (!event.repeat) toggleFullscreen();
      return true;
    case "m":
    case "M":
      if (!event.repeat) player.muted = !player.muted;
      return true;
    default:
      return false;
  }
}
