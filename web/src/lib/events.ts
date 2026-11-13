// The keeper's event streams (server-sent events), kept open.
//
// A browser reconnects an EventSource by itself when the connection drops. It does not when the
// reconnect is answered with an error, which is what a keeper that is restarting gives for a few
// seconds: the EventSource then closes for good. So this opens a new one, three seconds later.
import { KEEPER_URL } from "./config";

const REOPEN_MS = 3_000;

type Handlers = {
  /** The stream is open: events will arrive. */
  onReady: () => void;
  /** One `vault` message: the JSON of an event on the vault. */
  onEvent: (data: string) => void;
  /** The stream is down. It is being reconnected. */
  onDown: () => void;
};

/** Opens `path` on the keeper and keeps it open. Returns the function that closes it. */
export function follow(path: string, handlers: Handlers): () => void {
  if (typeof EventSource === "undefined") return () => undefined;
  let source: EventSource | null = null;
  let reopen: number | undefined;
  let closed = false;

  const open = () => {
    const next = new EventSource(`${KEEPER_URL}${path}`);
    source = next;
    next.addEventListener("ready", handlers.onReady);
    next.addEventListener("vault", (message) => handlers.onEvent((message as MessageEvent<string>).data));
    next.onerror = () => {
      handlers.onDown();
      if (!closed && next.readyState === EventSource.CLOSED) reopen = window.setTimeout(open, REOPEN_MS);
    };
  };
  open();

  return () => {
    closed = true;
    window.clearTimeout(reopen);
    source?.close();
  };
}
