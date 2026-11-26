// The plan page's reads of its own server (`/api/plan/*`), which reads the exchanges. Errors carry the
// server's sentence, written for the person using the page.
import type { BooksReply, GamesReply, VoucherMarket } from "@/lib/plan";

export class PlanError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, { signal, cache: "no-store" });
  const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
  if (!res.ok || body === null) {
    throw new PlanError(res.status, body?.error?.code ?? "unreachable", body?.error?.message ?? "We can't reach FreeIf right now. Try again in a moment.");
  }
  return body as T;
}

export const plan = {
  games: (league: string, signal?: AbortSignal) => get<GamesReply>(`/api/plan/games?league=${encodeURIComponent(league)}`, signal),
  /** One team's offers: `ticker` is its market on Kalshi, `other` its side of the game's market on Polymarket US. */
  books: (ticker: string, other: { slug: string; long: boolean } | null, signal?: AbortSignal) => {
    const q = new URLSearchParams({ ticker });
    if (other) {
      q.set("slug", other.slug);
      q.set("long", other.long ? "1" : "0");
    }
    return get<BooksReply>(`/api/plan/books?${q}`, signal);
  },
  voucher: (ticker: string, signal?: AbortSignal) => get<VoucherMarket>(`/api/plan/voucher?ticker=${encodeURIComponent(ticker)}`, signal),
};
