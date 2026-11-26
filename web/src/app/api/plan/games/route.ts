// A league's games for the plan page: each team with its market on Kalshi and, when the same game is
// found there, on Polymarket US.
import { get } from "@/lib/server/http";
import { PLAN_ROUTES } from "@/lib/server/limit";
import { games } from "@/lib/server/plan-data";

export const GET = get((query) => games(query.get("league") ?? "nba"), PLAN_ROUTES);
