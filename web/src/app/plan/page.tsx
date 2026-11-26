import type { Metadata } from "next";
import { PlanView } from "@/components/plan/plan-view";

const description = "Run a \"free if they win\" night. Cover it with one order in your own Kalshi account, and print the vouchers.";

export const metadata: Metadata = {
  title: "Plan a promo night · FreeIf",
  description,
  openGraph: { type: "website", siteName: "FreeIf", title: "FreeIf: plan a \"free if they win\" night", description },
};

export default function PlanPage() {
  return (
    // No site footer here: its "under the hood" panel describes the vault, and this page uses none.
    <PlanView />
  );
}
