"use client";

// How a promo's chance has moved since it started: the keeper's readings of the result's price on
// Gemini. The first read takes every reading; while the promo has no result, a read every 30 seconds
// asks only for the ones that are new.
import { useEffect, useRef, useState } from "react";
import { keeper, type Odds } from "./keeper";

const EVERY_MS = 30_000;

/** `live` is true while the promo has no result: the readings are read again as they come. */
export function useOdds(id: string, live: boolean): Odds | null {
  const [odds, setOdds] = useState<Odds | null>(null);
  // The newest reading this page holds, and of which promo: the next read asks for the later ones.
  const newest = useRef({ id: "", t: 0 });

  useEffect(() => {
    const controller = new AbortController();
    const load = () => {
      const after = newest.current.id === id ? newest.current.t : 0;
      return keeper.odds(id, after, controller.signal).then(
        (next) => {
          newest.current = { id, t: next.points.at(-1)?.[0] ?? after };
          setOdds((held) => {
            if (after === 0 || held === null || held.promoId !== next.promoId) return next;
            // Two reads that overlap bring the same readings: only the ones later than the last held are new.
            const last = held.points.at(-1)?.[0] ?? 0;
            return { ...next, points: [...held.points, ...next.points.filter((p) => p[0] > last)] };
          });
        },
        // A read that failed leaves the chart as it is; the next one asks again.
        () => undefined,
      );
    };
    void load();
    if (!live) return () => controller.abort();
    const timer = window.setInterval(() => void load(), EVERY_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [id, live]);

  return odds !== null && odds.promoId === id ? odds : null;
}
