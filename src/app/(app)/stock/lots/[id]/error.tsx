"use client";

import { RouteError } from "@/components/warehouse/route-states";

export default function LotError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteError what="this lot" reset={reset} />;
}
