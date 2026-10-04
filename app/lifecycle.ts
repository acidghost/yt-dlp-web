import type { startServer } from "./server";

type Signal = "SIGTERM" | "SIGINT";
type Outcome = "graceful" | "forced" | "failed";

// The executable owns process.exit. A deadline ends its wait, not cleanup.
export function createShutdown({
  app,
  log,
  complete,
  schedule = (callback, ms) => {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  },
}: {
  app: Pick<ReturnType<typeof startServer>, "close" | "forceStopHttp">;
  log: (message: string) => void;
  complete: (outcome: Outcome) => void;
  schedule?: (callback: () => void, ms: number) => () => void;
}) {
  let shuttingDown: Promise<Outcome> | undefined;
  return (signal: Signal): Promise<Outcome> => {
    if (shuttingDown) return shuttingDown;
    let resolve!: (outcome: Outcome) => void;
    shuttingDown = new Promise<Outcome>((done) => {
      resolve = done;
    });
    log(`Received ${signal}; stopping server`);
    let completed = false;
    const finish = (outcome: Outcome) => {
      if (completed) return;
      completed = true;
      cancelDeadline();
      resolve(outcome);
      complete(outcome);
    };
    const cancelDeadline = schedule(() => {
      void app
        .forceStopHttp()
        .catch(() => log("Could not force HTTP shutdown."));
      finish("forced");
    }, 5_000);
    void app.close().then(
      () => finish("graceful"),
      () => {
        log(
          "Application cleanup failed. Confirm remaining processes stopped before removing partial files.",
        );
        finish("failed");
      },
    );
    return shuttingDown;
  };
}

export function registerSignals(
  target: {
    on(signal: Signal, listener: () => void): unknown;
    removeListener(signal: Signal, listener: () => void): unknown;
  },
  shutdown: (signal: Signal) => Promise<Outcome>,
): () => void {
  const term = () => {
    void shutdown("SIGTERM");
  };
  const interrupt = () => {
    void shutdown("SIGINT");
  };
  target.on("SIGTERM", term);
  target.on("SIGINT", interrupt);
  return () => {
    target.removeListener("SIGTERM", term);
    target.removeListener("SIGINT", interrupt);
  };
}
