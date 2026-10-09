"use client";

import { RouteError } from "@/components/warehouse/route-states";

export default function CountError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteError what="this count" reset={reset} />;
}
