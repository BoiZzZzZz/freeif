// One team's offers on Kalshi and, when `slug` names its market there, on Polymarket US. The page works
// out the order from them, so changing the number of customers asks nothing new.
import { get } from "@/lib/server/http";
import { PLAN_ROUTES } from "@/lib/server/limit";
import { books } from "@/lib/server/plan-data";

export const GET = get((query) => books(query.get("ticker") ?? "", query.get("slug"), query.get("long") === "1"), PLAN_ROUTES);
