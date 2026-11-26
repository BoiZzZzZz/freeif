// What a voucher's page shows: the game, the team, and the result once Kalshi has one.
import { get } from "@/lib/server/http";
import { PLAN_ROUTES } from "@/lib/server/limit";
import { voucherMarket } from "@/lib/server/plan-data";

export const GET = get((query) => voucherMarket(query.get("ticker") ?? ""), PLAN_ROUTES);
