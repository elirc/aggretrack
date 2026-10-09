"use client";

import { RouteError } from "@/components/warehouse/route-states";

export default function NewCountError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteError what="the count sheet" reset={reset} />;
}
