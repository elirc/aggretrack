"use client";

import { RouteError } from "@/components/warehouse/route-states";

export default function MovementsError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteError what="movements" reset={reset} />;
}
