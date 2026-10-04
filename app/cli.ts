import { resetLibrary } from "./library";
import { startServer } from "./server";

// Import-safe command dispatch. Only the executable reads ambient argv/env.
export function runCli({
  argv,
  env,
  log,
  start = startServer,
  reset = resetLibrary,
}: {
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  log: (message: string) => void;
  start?: typeof startServer;
  reset?: typeof resetLibrary;
}) {
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== "--reset-db")) {
    throw new Error("Usage: yt-dlp-web [--reset-db]");
  }

  const dataDir = env.DATA_DIR ?? "./data";
  if (argv[0] === "--reset-db") {
    reset(dataDir);
    log(`Reset library database in ${dataDir}`);

    return null;
  }

  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid PORT");
  }

  const app = start({
    port,
    dataDir,
    hostname: env.HOST ?? "127.0.0.1",
    publicOrigin: env.PUBLIC_ORIGIN ?? null,
  });

  log(`Listening on http://${app.server.hostname}:${app.server.port}`);

  return app;
}
