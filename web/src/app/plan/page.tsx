import type { Metadata } from "next";
import { PlanView } from "@/components/plan/plan-view";

const description = "Run a \"free if they win\" night. Cover it with one order in your own Kalshi account, and print the vouchers.";

const title = "FreeIf: plan a \"free if they win\" night";

// A page's `openGraph` and `twitter` replace the layout's whole, the picture included, so each names
// the picture again. Without it a link to this page previews as text alone.
const picture = { width: 1200, height: 630, alt: "A FreeIf card: Wings, $8.00, free if the home team wins." };

export const metadata: Metadata = {
  title: "Plan a promo night · FreeIf",
  description,
  openGraph: { type: "website", siteName: "FreeIf", title, description, images: [{ url: "/opengraph-image.png", ...picture }] },
  twitter: { card: "summary_large_image", title, description, images: [{ url: "/twitter-image.png", ...picture }] },
};

export default function PlanPage() {
  return (
    // No site footer here: its "under the hood" panel describes the vault, and this page uses none.
    <PlanView />
  );
}
