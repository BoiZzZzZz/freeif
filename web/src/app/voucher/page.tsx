import type { Metadata } from "next";
import { Suspense } from "react";
import { VoucherView } from "@/components/voucher-view";
import { readVoucher } from "@/lib/plan";

export const metadata: Metadata = { title: "Voucher · FreeIf" };

export default function VoucherPage({ searchParams }: PageProps<"/voucher">) {
  return <Suspense fallback={null}>{searchParams.then((query) => <VoucherView voucher={readVoucher(query)} />)}</Suspense>;
}
