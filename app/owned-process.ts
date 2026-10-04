import { DownloadTerminationError, InputError } from "./media-errors";

// The only owner of download PIDs/groups. stop() confirms all writers stopped.
export function startOwnedProcess(command: readonly string[]) {
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new InputError("MP4 downloads require macOS or Linux.");
  const proc = Bun.spawn([...command], {
    detached: true,
    stdout: "pipe",
    stderr: "pipe",
  });
  let stopping: Promise<void> | undefined;
  return {
    stdout: proc.stdout,
    stderr: proc.stderr,
    exited: proc.exited,
    stop: () => (stopping ??= stopDownloadGroup(proc)),
  };
}

async function stopDownloadGroup(
  proc: ReturnType<typeof Bun.spawn>,
): Promise<void> {
  let probeError: unknown;
  const signal = (value: NodeJS.Signals | 0): boolean => {
    try {
      process.kill(-proc.pid, value);
      if (value === 0) probeError = undefined;
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return false;
      // Darwin's killpg1 skips zombies and returns EPERM when a group has no
      // signalable members. It can race reaping after TERM/KILL. A denied probe
      // means "not confirmed gone", never successful cleanup; poll boundedly.
      if (value === 0 && process.platform === "darwin" && code === "EPERM") {
        probeError = error;
        return true;
      }
      throw new DownloadTerminationError(
        "Could not stop the download process group safely. Partial files may remain.",
        { cause: error },
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
        { cause: probeError },
      );
  }
  await proc.exited;
}
