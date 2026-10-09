"use client";

import { RouteError } from "@/components/auth/RouteStates";

export default function RouteErrorBoundary({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteError error={error} reset={reset} title="Couldn't load expenses" />;
}
