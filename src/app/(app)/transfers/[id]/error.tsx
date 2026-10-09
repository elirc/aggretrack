"use client";

import { RouteError } from "@/components/warehouse/route-states";

export default function TransferError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteError what="this transfer" reset={reset} />;
}
