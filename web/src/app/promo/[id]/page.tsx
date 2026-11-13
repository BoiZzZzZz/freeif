import type { Metadata } from "next";
import { Suspense } from "react";
import { PromoView } from "@/components/promo-view";

export const metadata: Metadata = { title: "Promo · FreeIf" };

export default function PromoPage({ params }: PageProps<"/promo/[id]">) {
  return <Suspense fallback={null}>{params.then(({ id }) => <PromoView id={id} />)}</Suspense>;
}
