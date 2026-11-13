"use client";

// One promo, kept current. The keeper holds an event stream open for the page: each event on the promo
// arrives the moment the keeper has it (delivered by the QuickNode Stream, or read from the chain by the
// keeper), the page shows its line at once and reads the promo again. A timer reads the promo as well,
// so a page whose connection dropped is never more than a few seconds behind.
import { useCallback, useEffect, useRef, useState } from "react";
import { KEEPER_URL } from "./config";
import { keeper, KeeperError, type FeedEvent, type Promo } from "./keeper";

const FINISHED = new Set(["PaidOut", "FinalizedNo", "Voided"]);
/**
 * When the promo is read after an event. Several events in one block (three payouts) arrive together and
 * share these reads. The later two are for a keeper whose node is a moment behind the event.
 */
const AFTER_AN_EVENT_MS = [50, 1500, 5000];

const byPosition = (a: FeedEvent, b: FeedEvent): number => a.block - b.block || a.logIndex - b.logIndex;

/** `promo` with the events of `known` it lacks: an answer that was already on its way when an event came in. */
function withEvents(promo: Promo, known: FeedEvent[]): Promo {
  const ids = new Set(promo.events.map((e) => e.id));
  const extra = known.filter((e) => !ids.has(e.id));
  return extra.length === 0 ? promo : { ...promo, events: [...promo.events, ...extra].sort(byPosition) };
}

export type LivePromo = {
  promo: Promo | null;
  /** True when the keeper does not know this promo, and never has while this page was open. */
  missing: boolean;
  /** Puts a promo the caller has just read on the page. */
  show: (promo: Promo) => void;
};

/** With `customer`, the promo also says that address's place in line and whether it has been paid. */
export function usePromo(id: string, customer: string | null = null): LivePromo {
  const [promo, setPromo] = useState<Promo | null>(null);
  const [missing, setMissing] = useState(false);
  const [connected, setConnected] = useState(false);
  const finished = promo !== null && FINISHED.has(promo.status);
  // Reads are numbered, so an answer that comes back after a newer one is dropped.
  const started = useRef(0);
  const shown = useRef(0);

  const show = useCallback((next: Promo) => {
    shown.current = ++started.current;
    setPromo((held) => withEvents(next, held?.promoId === next.promoId ? held.events : []));
  }, []);

  const load = useCallback(
    (signal?: AbortSignal) => {
      const mine = ++started.current;
      return keeper.promo(id, customer, signal).then(
        (next) => {
          if (mine < shown.current) return;
          shown.current = mine;
          setMissing(false);
          setPromo((held) => withEvents(next, held?.promoId === next.promoId ? held.events : []));
        },
        (err) => {
          if (err instanceof KeeperError && (err.status === 404 || err.status === 400)) setMissing(true);
        },
      );
    },
    [id, customer],
  );

  // The first read, and the timer: slow while the event stream is open, quick while it is not.
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const every = finished ? 60_000 : connected ? 15_000 : 4_000;
    const timer = window.setInterval(() => void load(controller.signal), every);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [load, finished, connected]);

  // The event stream. A promo that is over has no more events.
  useEffect(() => {
    if (finished || typeof EventSource === "undefined") return;
    const source = new EventSource(`${KEEPER_URL}/promos/${encodeURIComponent(id)}/events`);
    let again: number[] = [];
    source.addEventListener("ready", () => setConnected(true));
    source.addEventListener("vault", (message) => {
      let event: FeedEvent;
      try {
        event = JSON.parse((message as MessageEvent<string>).data) as FeedEvent;
      } catch {
        return;
      }
      // The line shows at once; the promo's numbers follow from the reads.
      setPromo((held) => (held ? withEvents(held, [event]) : held));
      again.forEach((timer) => window.clearTimeout(timer));
      again = AFTER_AN_EVENT_MS.map((ms) => window.setTimeout(() => void load(), ms));
    });
    // The browser reconnects by itself; until it has, the timer above reads every few seconds.
    source.onerror = () => setConnected(false);
    return () => {
      source.close();
      again.forEach((timer) => window.clearTimeout(timer));
    };
  }, [id, finished, load]);

  // A promo that has been on the page exists, whatever one later answer says.
  return { promo, missing: missing && promo === null, show };
}
