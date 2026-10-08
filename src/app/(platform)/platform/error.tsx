"use client";

import { Button } from "@/components/ui/button";

export default function PlatformError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-start gap-3 rounded-lg border border-destructive/30 p-4">
      <p className="font-medium">Couldn&apos;t load this platform page.</p>
      <p className="text-sm text-muted-foreground">The error has been logged. Try again.</p>
      <Button onClick={() => reset()}>Try again</Button>
    </div>
  );
}
