"use client";

// /voucher: what a printed voucher's code opens. It shows the same thing to the customer and to whoever
// is behind the bar: the game, and once it is over whether the voucher is good. The result is the
// exchange's own (the market the bar's order is on); the free item is the bar's to give, and nothing on
// this page pays anyone.
import Link from "next/link";
import { useEffect, useState } from "react";
import { dateOf, dayTime } from "@/lib/format";
import type { Voucher, VoucherMarket } from "@/lib/plan";
import { plan, PlanError } from "@/lib/plan-client";
import { useNow } from "@/lib/use-now";

/** A voucher for "that night only" stops being good this long after the game starts. */
const NIGHT_SECONDS = 18 * 3600;

type State = "soon" | "playing" | "won" | "ran-out" | "lost";

function stateOf(market: VoucherMarket, voucher: Voucher, now: number): State {
  if (!market.final) return market.startTime !== null && now >= market.startTime ? "playing" : "soon";
  if (!market.won) return "lost";
  const until = voucher.until > 0 ? voucher.until : market.startTime !== null ? market.startTime + NIGHT_SECONDS : 0;
  return until > 0 && now > until ? "ran-out" : "won";
}

export function VoucherView({ voucher }: { voucher: Voucher | null }) {
  const [market, setMarket] = useState<VoucherMarket | null>(null);
  const [problem, setProblem] = useState<"unknown" | "unreachable" | null>(null);
  const now = Math.floor(useNow(30_000) / 1000);
  const ticker = voucher?.ticker ?? null;
  const final = market?.final ?? false;

  // Asked for once, then every 30 seconds until the game has a result.
  useEffect(() => {
    if (ticker === null || final) return;
    const controller = new AbortController();
    const load = () =>
      plan.voucher(ticker, controller.signal).then(
        (m) => {
          setMarket(m);
          setProblem(null);
        },
        (err) => {
          if (!controller.signal.aborted) setProblem(err instanceof PlanError && (err.status === 404 || err.status === 400) ? "unknown" : "unreachable");
        },
      );
    load();
    const timer = window.setInterval(load, 30_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [ticker, final]);

  return (
    <main className="mx-auto w-full max-w-[440px] flex-1 px-4 pb-10 pt-6">
      <header className="mb-6 flex h-8 items-center">
        <Link href="/" className="text-[18px] font-semibold tracking-tight">
          FreeIf
        </Link>
      </header>
      {voucher === null || (problem === "unknown" && market === null) ? (
        <Note>We couldn&apos;t read this voucher. Scan its code again, or ask at the bar.</Note>
      ) : market === null ? (
        problem === "unreachable" ? (
          <Note>We can&apos;t reach FreeIf right now. This page keeps trying.</Note>
        ) : (
          <div className="h-[280px] animate-pulse rounded-[10px] border border-line bg-card" aria-label="Loading the voucher" />
        )
      ) : (
        <Ticket voucher={voucher} market={market} state={now === 0 ? null : stateOf(market, voucher, now)} />
      )}
    </main>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="rounded-[10px] border border-line bg-card p-5 text-[16px]">{children}</p>;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-4">
      <dt className="label w-[84px] shrink-0">{label}</dt>
      <dd className="min-w-0 text-[15px]">{children}</dd>
    </div>
  );
}

function Ticket({ voucher, market, state }: { voucher: Voucher; market: VoucherMarket; state: State | null }) {
  const team = market.team;
  const item = voucher.item.trim() || "your item";
  const place = voucher.business.trim();
  const grey = state === "lost" || state === "ran-out";
  const head =
    state === "won"
      ? `✓ THE ${team.toUpperCase()} WON`
      : state === "lost"
        ? "NOT THIS TIME"
        : state === "ran-out"
          ? "RAN OUT"
          : state === "playing"
            ? "GAME ON"
            : state === "soon"
              ? "NOT PLAYED YET"
              : "";
  const line =
    state === "won"
      ? `Show this voucher${place ? ` at ${place}` : ""} for free ${item.toLowerCase()}.`
      : state === "lost"
        ? `The ${team} lost. Nothing is free this time.`
        : state === "ran-out"
          ? `The ${team} won, but this voucher ${voucher.until > 0 ? `ran out on ${dateOf(voucher.until)}` : "was good that night only"}.`
          : state === "playing"
            ? "The game is on. Look again when it ends."
            : state === "soon"
              ? `Look again after the game. If the ${team} win, this is good for free ${item.toLowerCase()}.`
              : "";
  const goodUntil = voucher.until > 0 ? `Good until ${dateOf(voucher.until)}.` : "Good that night only.";

  return (
    <>
      <div className={`overflow-hidden rounded-[10px] border bg-card ${state === "won" ? "border-go/40" : "border-line"} ${grey ? "text-ink/60" : ""}`}>
        <div className={`px-5 pt-4 ${state === "won" ? "bg-go-tint pb-4" : ""}`}>
          <div className="flex items-center justify-between gap-3">
            <span className="label truncate">{place || "Voucher"}</span>
            <span className={`num shrink-0 text-[12px] font-medium tracking-[0.08em] ${state === "won" ? "text-go" : grey ? "text-ink/60" : "text-ink"}`}>{head}</span>
          </div>
          <p className="mt-4 truncate text-[22px] font-semibold leading-7">{voucher.item.trim() || "Free item"}</p>
          <p className="mt-1 text-[13px] font-semibold uppercase tracking-[0.06em]">Free if the {team} win</p>
        </div>

        {/* The perforation: a notch on each side with a dashed line between them. */}
        <div className="relative my-4 h-[18px]">
          <span className="absolute -left-[10px] top-0 size-[18px] rounded-full border border-line bg-paper" />
          <span className="absolute -right-[10px] top-0 size-[18px] rounded-full border border-line bg-paper" />
          <span className="absolute left-4 right-4 top-1/2 border-t border-dashed border-line" />
        </div>

        <dl className="space-y-1.5 px-5 pb-4">
          <Row label="Game">{market.game}</Row>
          {market.startTime !== null && (
            <Row label="Starts">
              <span className="num">{dayTime(market.startTime)}</span>
            </Row>
          )}
          {voucher.number > 0 && voucher.of > 0 && (
            <Row label="Voucher">
              <span className="num">
                {voucher.number} of {voucher.of}
              </span>
            </Row>
          )}
          {line && (
            <p className={`pt-2 text-[15px] ${state === "won" ? "font-medium text-go" : ""}`} role="status">
              {line}
            </p>
          )}
          {state === "won" && <p className="text-[14px] text-ink/60">{goodUntil} One per customer.</p>}
        </dl>
      </div>
      <p className="mt-4 text-[13px] text-ink/60">
        {place || "The bar"} gives the free item and keeps the paper voucher when it does. The result shown here is read from Kalshi, the exchange that settles
        the game.
      </p>
    </>
  );
}
