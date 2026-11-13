import type { Metadata } from "next";
import { MerchantForm } from "@/components/merchant/merchant-form";
import { SiteFooter } from "@/components/mechanics";

export const metadata: Metadata = { title: "Run a promo · FreeIf" };

export default function MerchantPage() {
  return (
    <>
      <MerchantForm />
      <SiteFooter />
    </>
  );
}
