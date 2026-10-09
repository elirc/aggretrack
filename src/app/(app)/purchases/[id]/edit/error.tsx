"use client";

import { RouteError } from "@/components/buying/route-error";

export default function ErrorBoundary({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteError what="the purchase form" reset={reset} />;
}
