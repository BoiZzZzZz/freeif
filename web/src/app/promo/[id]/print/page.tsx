import type { Metadata } from "next";
import { Suspense } from "react";
import { PrintView } from "@/components/print-view";

export const metadata: Metadata = { title: "Counter sign · FreeIf" };

export default function PrintPage({ params }: PageProps<"/promo/[id]/print">) {
  return <Suspense fallback={null}>{params.then(({ id }) => <PrintView id={id} />)}</Suspense>;
}
