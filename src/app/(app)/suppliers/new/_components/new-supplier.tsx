"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

import { SupplierForm } from "@/components/buying/supplier-form";
import { Button } from "@/components/ui/button";

export function NewSupplier() {
  const router = useRouter();
  return (
    <SupplierForm
      onSaved={(s) => router.push(`/suppliers/${s.id}`)}
      secondary={
        <Button asChild variant="outline" className="h-12 sm:h-9">
          <Link href="/suppliers">Cancel</Link>
        </Button>
      }
    />
  );
}
