import type { Metadata } from "next";
import { Suspense } from "react";
import { CardsView } from "@/components/cards-view";

export const metadata: Metadata = { title: "Your cards · FreeIf" };

export default function CardsPage({ params }: PageProps<"/promo/[id]/cards">) {
  return <Suspense fallback={null}>{params.then(({ id }) => <CardsView id={id} />)}</Suspense>;
}
