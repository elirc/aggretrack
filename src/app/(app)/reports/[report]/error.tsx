"use client";

import { RouteError } from "@/components/warehouse/route-states";

export default function ReportError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteError what="this report" reset={reset} />;
}
