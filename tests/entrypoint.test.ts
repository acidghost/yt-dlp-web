import { expect, mock, spyOn, test } from "bun:test";

// A broken import guard must fail safely, not start on the user's DATA_DIR or
// exit the runner. This override is confined to this isolated test file.
const runCli = mock(() => null);

mock.module("../app/cli", () => ({ runCli }));

test("importing the executable does not dispatch CLI, exit, or install process listeners", async () => {
  const term = process.listeners("SIGTERM");
  const interrupt = process.listeners("SIGINT");
  const exit = spyOn(process, "exit").mockImplementation(() => {
    throw new Error("Unexpected process.exit");
  });

  try {
    await import("../app/index");

    expect(runCli).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    expect(process.listeners("SIGTERM")).toEqual(term);
    expect(process.listeners("SIGINT")).toEqual(interrupt);
  } finally {
    exit.mockRestore();

    for (const [signal, previous] of [
      ["SIGTERM", term],
      ["SIGINT", interrupt],
    ] as const) {
      for (const listener of process.listeners(signal)) {
        if (!previous.includes(listener)) {
          process.removeListener(signal, listener);
        }
      }
    }
  }
});
