"use client";

import { Button } from "@/components/ui/button";

export default function MasterDataError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-start gap-3 rounded-lg border border-destructive/30 p-4">
      <p className="font-medium">Couldn&apos;t load master data.</p>
      <p className="text-sm text-muted-foreground">Check your connection and try again.</p>
      <Button className="h-11 sm:h-9" onClick={() => reset()}>
        Try again
      </Button>
    </div>
  );
}
