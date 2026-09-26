import { startServer } from "./server";

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Invalid PORT");
const server = startServer({ port });
console.log(`Listening on http://${server.hostname}:${server.port}`);
