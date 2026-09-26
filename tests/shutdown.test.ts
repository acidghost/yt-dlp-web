import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("SIGTERM stops the HTTP server and exits cleanly", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yt-dlp-web-shutdown-"));
  const env: Record<string, string | undefined> = {
    ...process.env,
    PORT: "3000",
    HOST: "127.0.0.1",
    DATA_DIR: dataDir,
  };
  delete env.PUBLIC_ORIGIN;
  const proc = Bun.spawn(["bun", join(import.meta.dir, "../app/index.ts")], {
    env,
    stdout: "ignore",
    stderr: "ignore",
  });

  try {
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try {
        ready = (await fetch("http://127.0.0.1:3000/healthz")).ok;
        if (ready) break;
      } catch {
        // Wait for the child to bind.
      }
      await Bun.sleep(50);
    }
    expect(ready).toBe(true);
    proc.kill("SIGTERM");
    const exitCode = await Promise.race([
      proc.exited,
      Bun.sleep(2_000).then(() => null),
    ]);
    expect(exitCode).toBe(0);
  } finally {
    if (proc.exitCode === null) proc.kill("SIGKILL");
    await proc.exited;
    await rm(dataDir, { recursive: true, force: true });
  }
});
