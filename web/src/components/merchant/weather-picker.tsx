"use client";

// Step 1 of the form when the business itself gets paid (prep/WIREFRAMES.md section 7.5): which day,
// which temperature. The list is Gemini's daily high-temperature markets, one per city and day, each
// with a button per range. A day can be picked until it begins.
import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { dayTime, pct } from "@/lib/format";
import { keeper, type Game, type GamesReply } from "@/lib/keeper";
import type { Pick } from "@/components/merchant/game-picker";

type Props = { picked: Pick | null; onPick: (pick: Pick) => void };

const FIRST_SHOWN = 4;

export function WeatherPicker({ picked, onPick }: Props) {
  const [reply, setReply] = useState<GamesReply | null>(null);
  const [failed, setFailed] = useState(false);
  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const load = () =>
      keeper.weather(controller.signal).then(
        (markets) => {
          setReply(markets);
          setFailed(false);
        },
        () => {
          if (!controller.signal.aborted) setFailed(true);
        },
      );
    load();
    // Chances on the buttons are refreshed quietly; the price card has the live one.
    const timer = window.setInterval(load, 60_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, []);

  const loaded = reply?.games ?? null;
  const words = search.trim().toLowerCase();
  const matching = (loaded ?? []).filter((m) => words === "" || (m.city ?? m.game).toLowerCase().includes(words));
  // The day already picked stays in view when the list is cut short.
  const shown =
    showAll || words !== "" ? matching : matching.filter((m, i) => i < FIRST_SHOWN || m.eventTicker === picked?.game.eventTicker);

  // Markets under a heading per day, as Gemini names the day: "November 14".
  const days: { heading: string; markets: Game[] }[] = [];
  for (const market of shown) {
    const heading = market.day ?? "";
    const last = days[days.length - 1];
    if (last && last.heading === heading) last.markets.push(market);
    else days.push({ heading, markets: [market] });
  }

  return (
    <div className="space-y-3">
      <Input type="search" placeholder="Search a city" aria-label="Search a city" value={search} onChange={(e) => setSearch(e.target.value)} />

      {loaded === null && !failed && (
        <div className="space-y-2" aria-label="Loading days">
          {[0, 1].map((i) => (
            <div key={i} className="h-[196px] animate-pulse rounded-[10px] border border-line bg-card" />
          ))}
        </div>
      )}
      {loaded === null && failed && (
        <p className="rounded-[10px] border border-line bg-card p-4 text-[15px]">We can&apos;t load the days right now. Try again in a moment.</p>
      )}
      {loaded !== null && matching.length === 0 && (
        <p className="rounded-[10px] border border-line bg-card p-4 text-[15px] text-ink/60">
          {words === "" ? "No days are open right now. Tomorrow's opens each morning." : "No city matches that search."}
        </p>
      )}

      {days.map((day) => (
        <div key={day.heading} className="space-y-2">
          <h3 className="label pt-1">The high on {day.heading}</h3>
          {day.markets.map((market) => (
            <div key={market.eventTicker} className="rounded-[10px] border border-line bg-card p-3">
              <p className="text-[15px]">
                {market.city ?? market.game} <span className="num text-ink/60">· buy by {dayTime(market.startTime)}</span>
              </p>
              <div className="mt-2 grid grid-cols-2 gap-2">
                {market.teams.map((range) => {
                  const selected = picked?.team.instrumentSymbol === range.instrumentSymbol;
                  return (
                    <button
                      key={range.instrumentSymbol}
                      type="button"
                      disabled={!range.quotable}
                      aria-pressed={selected}
                      title={range.quotable ? undefined : "This range has no price right now"}
                      onClick={() => onPick({ game: market, team: range })}
                      className={`flex h-12 items-center justify-between gap-2 rounded-[10px] border px-3 text-left text-[15px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed disabled:opacity-40 ${
                        selected ? "border-ink bg-ink text-white" : "border-line bg-paper hover:border-ink/40"
                      }`}
                    >
                      <span className="truncate">{range.team}</span>
                      {/* A range nobody is quoting shows a cent on Gemini. That is not a 1% chance. */}
                      <span className="num shrink-0">{range.quotable && range.chance !== null ? pct(range.chance) : "—"}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      ))}

      {!showAll && words === "" && matching.length > shown.length && (
        <button className="text-[14px] underline underline-offset-2" onClick={() => setShowAll(true)}>
          Show all {matching.length} cities
        </button>
      )}
    </div>
  );
}
