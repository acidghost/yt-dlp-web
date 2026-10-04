export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

// Only for real HTTP/filesystem progress, not fixture-controlled readiness.
export async function waitFor<T>(
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  description: string,
): Promise<T> {
  const deadline = performance.now() + 2500;
  let last: T | undefined;
  do {
    last = await read();
    if (ready(last)) return last;
    await Bun.sleep(5);
  } while (performance.now() < deadline);
  throw new Error(
    `Timed out waiting for ${description}; last result: ${JSON.stringify(last)}`,
  );
}
