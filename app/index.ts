import { runCli } from "./cli";
import { createShutdown, registerSignals } from "./lifecycle";

if (import.meta.main) {
  const app = runCli({
    argv: process.argv.slice(2),
    env: process.env,
    log: console.log,
  });
  if (app) {
    const shutdown = createShutdown({
      app,
      log: console.log,
      complete: (outcome) => process.exit(outcome === "failed" ? 1 : 0),
    });

    registerSignals(process, shutdown);
  }
}
