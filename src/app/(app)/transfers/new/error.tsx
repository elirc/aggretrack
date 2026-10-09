"use client";

import { RouteError } from "@/components/warehouse/route-states";

export default function NewTransferError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteError what="the transfer form" reset={reset} />;
}
