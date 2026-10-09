"use client";

import { RouteError } from "@/components/warehouse/route-states";

export default function StockError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteError what="stock" reset={reset} />;
}
