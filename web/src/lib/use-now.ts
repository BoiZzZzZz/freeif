"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * The current time in milliseconds, rounded down to `stepMs`, re-rendering each step. It is 0 on the
 * server and on the first render in the browser, so the two agree; callers treat 0 as "not known yet".
 */
export function useNow(stepMs = 15_000): number {
  const subscribe = useCallback(
    (notify: () => void) => {
      const timer = window.setInterval(notify, stepMs);
      return () => window.clearInterval(timer);
    },
    [stepMs],
  );
  return useSyncExternalStore(
    subscribe,
    () => Math.floor(Date.now() / stepMs) * stepMs,
    () => 0,
  );
}
