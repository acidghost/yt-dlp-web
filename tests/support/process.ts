import { mock } from "bun:test";
import { deferred } from "./async";

// Real pipes, no PID. Only the external process's events are controlled.
export function controlledProcess() {
  const done = deferred<number>();
  let out!: ReadableStreamDefaultController<Uint8Array>;
  let err!: ReadableStreamDefaultController<Uint8Array>;
  let exitCode: number | null = null;
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      out = controller;
    },
  });
  const stderr = new ReadableStream<Uint8Array>({
    start(controller) {
      err = controller;
    },
  });
  const end = () => {
    // Readers may already have canceled a pipe after failure/abort.
    try {
      out.close();
    } catch {}
    try {
      err.close();
    } catch {}
  };
  const exit = (code = 0) => {
    exitCode = code;
    end();
    done.resolve(code);
  };
  return {
    stdout,
    stderr,
    exited: done.promise,
    get exitCode() {
      return exitCode;
    },
    emitStdout: (text: string | Uint8Array) =>
      out.enqueue(
        typeof text === "string" ? new TextEncoder().encode(text) : text,
      ),
    emitStderr: (text: string) => err.enqueue(new TextEncoder().encode(text)),
    failStdout: (error: Error) => out.error(error),
    exit,
    stop: mock(async () => {
      exit();
    }),
    kill: mock(() => {
      exit(1);
    }),
  };
}
