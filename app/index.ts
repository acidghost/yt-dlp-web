import { startServer } from "./server";

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Invalid PORT");
const server = startServer({ port });
console.log(`Listening on http://${server.hostname}:${server.port}`);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; stopping server`);

  // Let active requests finish briefly, then close long-lived media streams.
  // Docker sends SIGKILL after 10 seconds by default.
  const deadline = setTimeout(() => {
    server.stop(true);
    process.exit(0);
  }, 5_000);
  try {
    await server.stop();
  } finally {
    clearTimeout(deadline);
    process.exit(0);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
