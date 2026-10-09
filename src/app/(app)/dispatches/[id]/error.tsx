"use client";

import { RouteError } from "@/components/selling/route-error";

export default function SellingRouteError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteError what="this dispatch" reset={reset} />;
}
