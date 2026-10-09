"use client";

import { Button } from "@/components/ui/button";

/** Body for the buying routes' error.tsx boundaries. */
export function RouteError({ what, reset }: { what: string; reset: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-start gap-3 rounded-lg border border-destructive/30 p-4">
      <p className="font-medium">Couldn&apos;t load {what}.</p>
      <p className="text-sm text-muted-foreground">Check your connection and try again.</p>
      <Button className="h-11 sm:h-9" onClick={() => reset()}>
        Try again
      </Button>
    </div>
  );
}
