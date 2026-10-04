import { expect, spyOn, test } from "bun:test";
import { startOwnedProcess } from "../app/owned-process";
import { controlledProcess } from "./support/process";

// Never allocate a PID or signal the OS in these branch tests. Every syscall
// is intercepted before the real production launcher is invoked.
for (const mode of ["gone", "blocked", "unconfirmed"] as const) {
  test(`owned stop handles ${mode} group safely and is idempotent`, async () => {
    const proc = controlledProcess();

    proc.exit();

    const spawn = spyOn(Bun, "spawn").mockImplementation(
      () => ({ ...proc, pid: 123 }) as unknown as ReturnType<typeof Bun.spawn>,
    );
    const cause = Object.assign(new Error("Permission denied"), {
      code: "EPERM",
    });
    const kill = spyOn(process, "kill").mockImplementation(() => {
      if (mode === "blocked") {
        throw cause;
      }
      if (mode === "gone") {
        throw Object.assign(new Error("Gone"), { code: "ESRCH" });
      }

      return true;
    });
    let time = 0;
    const clock = spyOn(Date, "now").mockImplementation(() => {
      time += 10_000;

      return time;
    });

    try {
      const owned = startOwnedProcess(["fixture"]);
      const stopping = owned.stop();

      expect(owned.stop()).toBe(stopping);

      if (mode === "gone") {
        await stopping;
      } else if (mode === "blocked") {
        await expect(stopping).rejects.toMatchObject({
          cause,
          message: "Could not stop the download process group safely. Partial files may remain.",
        });
      } else {
        await expect(stopping).rejects.toThrow("Could not confirm download process cleanup");
        expect(kill.mock.calls).toContainEqual([-123, "SIGKILL"]);
      }

      expect(spawn.mock.calls[0]?.[1]).toMatchObject({ detached: true });
      expect(kill.mock.calls.every(([pid]) => pid === -123)).toBe(true);
    } finally {
      clock.mockRestore();
      kill.mockRestore();
      spawn.mockRestore();
    }
  });
}

for (const mode of ["darwin-reaped", "darwin-denied", "linux-denied"] as const) {
  test(`owned stop handles ${mode} existence probes without assuming cleanup`, async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform");

    Object.defineProperty(process, "platform", {
      ...platform,
      value: mode.startsWith("darwin") ? "darwin" : "linux",
    });

    const proc = controlledProcess();

    proc.exit();

    const spawn = spyOn(Bun, "spawn").mockImplementation(
      () => ({ ...proc, pid: 123 }) as unknown as ReturnType<typeof Bun.spawn>,
    );
    const cause = Object.assign(new Error("Group has no signalable members"), {
      code: "EPERM",
    });
    let probes = 0;
    const kill = spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal === 0) {
        probes++;
        if (mode === "darwin-reaped" && probes > 1) {
          throw Object.assign(new Error("Gone"), { code: "ESRCH" });
        }

        throw cause;
      }

      return true;
    });
    let time = 0;
    const clock =
      mode === "darwin-reaped"
        ? undefined
        : spyOn(Date, "now").mockImplementation(() => {
            time += 10_000;

            return time;
          });

    try {
      const owned = startOwnedProcess(["fixture"]);
      const stopping = owned.stop();

      expect(owned.stop()).toBe(stopping);

      if (mode === "darwin-reaped") {
        await stopping;

        expect(probes).toBe(2);
        expect(kill.mock.calls).toEqual([
          [-123, "SIGTERM"],
          [-123, 0],
          [-123, 0],
        ]);
      } else {
        await expect(stopping).rejects.toMatchObject({
          cause,
          message:
            mode === "darwin-denied"
              ? "Could not confirm download process cleanup. Partial files may remain."
              : "Could not stop the download process group safely. Partial files may remain.",
        });

        if (mode === "darwin-denied") {
          expect(kill.mock.calls).toContainEqual([-123, "SIGKILL"]);
        } else {
          expect(kill.mock.calls).toEqual([
            [-123, "SIGTERM"],
            [-123, 0],
          ]);
        }
      }
    } finally {
      clock?.mockRestore();
      kill.mockRestore();
      spawn.mockRestore();
      if (platform) {
        Object.defineProperty(process, "platform", platform);
      }
    }
  });
}
