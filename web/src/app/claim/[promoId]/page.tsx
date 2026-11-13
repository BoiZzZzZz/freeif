import type { Metadata } from "next";
import { Suspense } from "react";
import { ClaimView } from "@/components/claim-view";

export const metadata: Metadata = { title: "Get covered · FreeIf" };

export default function ClaimPage({ params }: PageProps<"/claim/[promoId]">) {
  // The promo id is only known per request, so the page streams in behind a fallback.
  return <Suspense fallback={null}>{params.then(({ promoId }) => <ClaimView promoId={promoId} />)}</Suspense>;
}
