import type { Metadata } from "next";
import { Suspense } from "react";
import { CardView } from "@/components/card-view";

export const metadata: Metadata = { title: "Your card · FreeIf" };

// The card's key is after "#" in the address, which no browser sends: the page reads it in the browser.
export default function CardPage({ params }: PageProps<"/card/[promoId]">) {
  return <Suspense fallback={null}>{params.then(({ promoId }) => <CardView promoId={promoId} />)}</Suspense>;
}
