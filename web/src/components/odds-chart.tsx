"use client";

// The chart on the promo page (prep/WIREFRAMES.md section 9.3): one line, the chance of the promo's
// result from the moment the promo started to its newest reading. The readings are the keeper's, of the
// result's price on Gemini. Drawn by hand: one line on a fixed 0 to 100% scale needs no chart library.
import { useMemo, useState } from "react";
import { KEEPER_URL } from "@/lib/config";
import { dayTime, pct, timeOf } from "@/lib/format";
import type { Odds, OddsPoint, Promo } from "@/lib/keeper";

/** 4300 -> "0.43", a price as Gemini writes it. */
const price = (bps: number | null): string => (bps === null ? "none" : (bps / 10_000).toFixed(2));
/** Where a chance sits in the plot, as a percentage from its top. */
const top = (point: OddsPoint): number => 100 - point[1] / 100;

/** The reading nearest to a time. `series` is oldest first and not empty. */
function nearest(series: OddsPoint[], t: number): number {
  let low = 0;
  let high = series.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (series[middle]![0] < t) low = middle + 1;
    else high = middle;
  }
  return low > 0 && t - series[low - 1]![0] < series[low]![0] - t ? low - 1 : low;
}

export function OddsChart({ promo, odds, merchant, mechanics }: { promo: Promo; odds: Odds | null; merchant: boolean; mechanics: boolean }) {
  /** The reading under the pointer, or the one the arrow keys have reached. */
  const [picked, setPicked] = useState<number | null>(null);

  // The line: the reading the promo was priced on, the ones the keeper kept, and the newest.
  const { series, path } = useMemo(() => {
    const series: OddsPoint[] = odds?.start ? [odds.start] : [];
    for (const point of odds?.points ?? []) if (point[0] > (series.at(-1)?.[0] ?? 0)) series.push(point);
    if (odds?.latest && odds.latest[0] > (series.at(-1)?.[0] ?? 0)) series.push(odds.latest);
    const first = series[0]?.[0] ?? 0;
    const span = Math.max((series.at(-1)?.[0] ?? 0) - first, 1);
    // While the keeper is reading, two readings that differ are one pass apart (it keeps the reading
    // before every change). Two that differ and are further apart have a stretch with no reading between
    // them: the book was no price, or the keeper was down. The line holds its level across that stretch
    // and steps at the new reading, where a straight line would draw a slope nobody saw.
    const stretch = (odds?.everySeconds ?? 30) * 2.5;
    let path = "";
    series.forEach((p, i) => {
      const x = (((p[0] - first) / span) * 100).toFixed(2);
      const y = top(p).toFixed(2);
      const before = series[i - 1];
      if (before === undefined) path += `M${x} ${y}`;
      else if (p[1] !== before[1] && p[0] - before[0] > stretch) path += `H${x}V${y}`;
      else path += `L${x} ${y}`;
    });
    return { series, path };
  }, [odds]);

  const live = promo.status === "Open";
  const title = `Chance ${promo.condition ?? "it happens"}`;
  if (odds === null) return null;
  if (series.length === 0) {
    // A promo that ended before readings were kept has no chart. One that is running gets its first within a minute.
    if (!live) return null;
    return (
      <section className="mt-8">
        <h2 className="label mb-2">{title}</h2>
        <p className="rounded-[10px] border border-line bg-card px-4 py-3 text-[15px] text-ink/60">No reading of the chance yet.</p>
      </section>
    );
  }

  const first = series[0]!;
  const last = series.at(-1)!;
  const span = Math.max(last[0] - first[0], 1);
  const left = (t: number): number => ((t - first[0]) / span) * 100;
  // A span inside one day reads "7:15 PM"; a longer one says the day too.
  const sameDay = new Date(first[0] * 1000).toDateString() === new Date(last[0] * 1000).toDateString();
  const when = sameDay ? timeOf : dayTime;
  const kickoff = promo.eventStartTime !== null && promo.eventStartTime > first[0] && promo.eventStartTime < last[0] ? promo.eventStartTime : null;
  const at = picked !== null && picked < series.length ? series[picked]! : null;
  // The first point's label goes on the side of its dot the line leaves free: under it when the chance
  // rose over the first half of the span, over it when it fell. Near an edge of the plot it goes inward.
  const early = series.filter((p) => p[0] <= first[0] + span / 2).map((p) => p[1]);
  const rose = Math.max(...early) - first[1] > first[1] - Math.min(...early);
  const labelUnder = top(first) < 15 || (rose && top(first) <= 85);

  const pick = (clientX: number, box: DOMRect) => {
    const part = Math.min(Math.max((clientX - box.left) / box.width, 0), 1);
    setPicked(nearest(series, first[0] + part * span));
  };
  const step = (by: number) => setPicked((held) => Math.min(Math.max((held ?? series.length - 1) + by, 0), series.length - 1));

  return (
    <section className="mt-8">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 className="label">{title}</h2>
        <p className="shrink-0 text-right">
          <span className="num text-[20px] font-semibold leading-7">{pct(last[1] / 10_000)}</span>
          {!live && <span className="ml-2 text-[13px] text-ink/60">at the last reading</span>}
        </p>
      </div>
      <div className="rounded-[10px] border border-line bg-card px-4 pb-3 pt-5">
        <div className="flex">
          <div className="num relative h-[200px] w-9 shrink-0 text-[12px] text-ink/60" aria-hidden>
            {[100, 50, 0].map((value) => (
              <span key={value} className="absolute left-0 -translate-y-1/2" style={{ top: `${100 - value}%` }}>
                {value}%
              </span>
            ))}
          </div>
          <div
            className="relative h-[200px] min-w-0 flex-1 touch-pan-y rounded-[2px] outline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink/40"
            role="group"
            tabIndex={0}
            aria-label={`${title}: ${pct(last[1] / 10_000)} at ${when(last[0])}, ${pct(first[1] / 10_000)} at ${when(first[0])}. The left and right arrow keys read each point.`}
            onPointerMove={(e) => pick(e.clientX, e.currentTarget.getBoundingClientRect())}
            onPointerDown={(e) => pick(e.clientX, e.currentTarget.getBoundingClientRect())}
            onPointerLeave={() => setPicked(null)}
            onBlur={() => setPicked(null)}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft") step(-1);
              else if (e.key === "ArrowRight") step(1);
              else if (e.key === "Home") setPicked(0);
              else if (e.key === "End") setPicked(series.length - 1);
              else if (e.key === "Escape") setPicked(null);
              else return;
              e.preventDefault();
            }}
          >
            {[0, 50, 100].map((value) => (
              <span key={value} className="absolute left-0 right-0 h-px bg-line" style={{ top: `${value}%` }} />
            ))}

            {kickoff !== null && (
              <>
                <span className="absolute top-0 h-full w-px bg-ink/25" style={{ left: `${left(kickoff)}%` }} />
                <span
                  className="label pointer-events-none absolute bottom-1 whitespace-nowrap bg-card/85 px-1"
                  style={left(kickoff) < 50 ? { left: `calc(${left(kickoff)}% + 4px)` } : { right: `calc(${100 - left(kickoff)}% + 4px)` }}
                >
                  {promo.subject ? "Kickoff" : "Start"}
                </span>
              </>
            )}

            <svg className="absolute inset-0 h-full w-full overflow-visible" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
              <path d={path} fill="none" stroke="var(--color-ink)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
            </svg>

            {odds.start !== null && (
              <>
                <span className="absolute left-0 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-ink ring-2 ring-card" style={{ top: `${top(first)}%` }} />
                <span
                  className="num pointer-events-none absolute left-2 whitespace-nowrap rounded-[4px] bg-card/85 px-1 text-[12px] text-ink/70"
                  style={{ top: `${top(first)}%`, transform: labelUnder ? "translateY(6px)" : "translateY(calc(-100% - 6px))" }}
                >
                  {pct(first[1] / 10_000)} when {merchant ? "you" : "the promo"} started
                </span>
              </>
            )}
            {series.length > 1 && (
              <span className="absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-go ring-2 ring-card" style={{ left: "100%", top: `${top(last)}%` }} />
            )}

            {at !== null && (
              <>
                <span className="pointer-events-none absolute top-0 h-full w-px bg-ink/40" style={{ left: `${left(at[0])}%` }} />
                <span
                  className="pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-ink ring-2 ring-card"
                  style={{ left: `${left(at[0])}%`, top: `${top(at)}%` }}
                />
                <p
                  className="pointer-events-none absolute top-0 z-10 whitespace-nowrap rounded-[6px] border border-line bg-card px-2 py-1 text-[12px] leading-4 shadow-sm"
                  style={{ left: `${left(at[0])}%`, transform: left(at[0]) > 55 ? "translateX(calc(-100% - 8px))" : "translateX(8px)" }}
                  aria-live="polite"
                >
                  <span className="num block text-[14px] font-semibold leading-5">{pct(at[1] / 10_000)}</span>
                  <span className="num block text-ink/60">{when(at[0])}</span>
                  {mechanics && (
                    <span className="num block text-ink/60">
                      bid {price(at[2])} · ask {price(at[3])}
                    </span>
                  )}
                </p>
              </>
            )}
          </div>
        </div>
        <div className="num ml-9 mt-2 flex justify-between text-[12px] text-ink/60">
          <span>{when(first[0])}</span>
          {series.length > 1 && <span>{when(last[0])}</span>}
        </div>
        {mechanics && (
          <p className="num mt-3 border-t border-line pt-3 text-[12px] text-ink/60">
            Gemini&apos;s order book{promo.instrumentSymbol ? ` for ${promo.instrumentSymbol}` : ""}: the best ask, read every {odds.everySeconds} seconds.{" "}
            {live ? "Now" : "Last"}: bid {price(last[2])} · ask {price(last[3])}. {series.length} readings.{" "}
            <a className="underline underline-offset-2" href={`${KEEPER_URL}/promos/${promo.promoId}/odds`} target="_blank" rel="noreferrer">
              The readings as the keeper has them
            </a>
          </p>
        )}
      </div>
    </section>
  );
}
