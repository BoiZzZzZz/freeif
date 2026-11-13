/**
 * Waits `ms`, or less: it ends early when `signal` aborts, or when the function handed to `onWake` is
 * called. It leaves no timer and no listener behind.
 */
export function sleep(ms: number, signal?: AbortSignal, onWake?: (wake: () => void) => void): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
    onWake?.(done);
  });
}
