"use client";

// Step 1 of the plan page: which game, which team. One tap picks both. It looks like the merchant form's
// picker, and its list comes from the exchange's own open games (`/api/plan/games`).
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { dayHeading, pct, timeOf } from "@/lib/format";
import type { GamesReply, PlanGame, PlanTeam } from "@/lib/plan";
import { plan } from "@/lib/plan-client";
import { useNow } from "@/lib/use-now";

export type Choice = { game: PlanGame; team: PlanTeam };

type Props = { picked: Choice | null; onPick: (choice: Choice) => void };

// Until the server answers, the tabs it is known to serve (lib/server/kalshi.ts).
const LEAGUES = [
  { key: "nba", name: "Pro Basketball" },
  { key: "nhl", name: "Pro Hockey" },
  { key: "nfl", name: "Pro Football" },
];
const FIRST_SHOWN = 8;

export function GameList({ picked, onPick }: Props) {
  const [league, setLeague] = useState(LEAGUES[0]!.key);
  const [reply, setReply] = useState<GamesReply | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState(false);
  const now = useNow(60_000);

  useEffect(() => {
    const controller = new AbortController();
    const load = () =>
      plan.games(league, controller.signal).then(
        (games) => {
          setReply(games);
          setFailed(null);
        },
        () => {
          if (!controller.signal.aborted) setFailed(league);
        },
      );
    load();
    // Chances on the buttons are refreshed quietly; the order card has the live numbers.
    const timer = window.setInterval(load, 60_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [league]);

  const leagues = reply?.leagues ?? LEAGUES;
  const loaded = reply && reply.league === league ? reply.games : null;
  const words = search.trim().toLowerCase();
  // A game that has started since the list was read is no longer one to plan on.
  const open = (loaded ?? []).filter((g) => now === 0 || g.startTime * 1000 > now);
  const matching = open.filter((g) => words === "" || g.game.toLowerCase().includes(words) || g.kalshiTitle.toLowerCase().includes(words));
  const shown = showAll || words !== "" ? matching : matching.slice(0, FIRST_SHOWN);

  // Games under a heading per day: Tonight, Tomorrow, Sun, Nov 15.
  const days: { heading: string; games: PlanGame[] }[] = [];
  for (const game of shown) {
    const heading = dayHeading(game.startTime, now || undefined);
    const last = days[days.length - 1];
    if (last && last.heading === heading) last.games.push(game);
    else days.push({ heading, games: [game] });
  }

  return (
    <div className="space-y-3">
      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none]">
        {leagues.map((l) => (
          <Button
            key={l.key}
            variant="chip"
            selected={l.key === league}
            onClick={() => {
              setLeague(l.key);
              setShowAll(false);
            }}
          >
            {l.name}
          </Button>
        ))}
      </div>
      <Input type="search" placeholder="Search a team or a city" aria-label="Search a team or a city" value={search} onChange={(e) => setSearch(e.target.value)} />

      {loaded !== null && matching.length > 0 && (
        <p className="text-[14px] text-ink/60">The number next to each team is its chance to win, from Kalshi&apos;s prices right now.</p>
      )}

      {loaded === null && failed !== league && (
        <div className="space-y-2" aria-label="Loading games">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-[88px] animate-pulse rounded-[10px] border border-line bg-card" />
          ))}
        </div>
      )}
      {loaded === null && failed === league && (
        <p className="rounded-[10px] border border-line bg-card p-4 text-[15px]">We can&apos;t load the games right now. Try again in a moment.</p>
      )}
      {loaded !== null && matching.length === 0 && (
        <p className="rounded-[10px] border border-line bg-card p-4 text-[15px] text-ink/60">
          {words === "" ? "No games are coming up in this league right now." : "No game matches that search."}
        </p>
      )}

      {days.map((day) => (
        <div key={day.heading} className="space-y-2">
          <h3 className="label pt-1">{day.heading}</h3>
          {day.games.map((game) => (
            <div key={game.id} className="rounded-[10px] border border-line bg-card p-3">
              <p className="text-[15px]">
                {game.game} <span className="num text-ink/60">· {timeOf(game.startTime)}</span>
              </p>
              <div className="mt-2 grid grid-cols-2 gap-2">
                {game.teams.map((team) => {
                  const selected = picked?.team.ticker === team.ticker;
                  return (
                    <button
                      key={team.ticker}
                      type="button"
                      disabled={team.ask === null}
                      aria-pressed={selected}
                      title={team.ask === null ? "Nobody is offering this team right now" : undefined}
                      onClick={() => onPick({ game, team })}
                      className={`flex h-12 items-center justify-between gap-2 rounded-[10px] border px-3 text-left text-[15px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed disabled:opacity-40 ${
                        selected ? "border-ink bg-ink text-white" : "border-line bg-paper hover:border-ink/40"
                      }`}
                    >
                      <span className="truncate">{team.name}</span>
                      <span className="num shrink-0">{team.ask === null ? "—" : pct(team.ask)}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      ))}

      {!showAll && words === "" && matching.length > FIRST_SHOWN && (
        <button className="text-[14px] underline underline-offset-2" onClick={() => setShowAll(true)}>
          Show all {matching.length} games
        </button>
      )}
    </div>
  );
}
