"use client";

import Link from "next/link";

import { Button } from "@/components/ui/button";

export default function OnboardingError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div role="alert" className="mx-auto flex max-w-xl flex-col items-start gap-3 rounded-lg border border-destructive/30 p-4">
      <p className="font-medium">The setup wizard couldn&apos;t load.</p>
      <p className="text-sm text-muted-foreground">Try again, or skip it and set things up later in Settings.</p>
      <div className="flex gap-2">
        <Button className="h-11 sm:h-9" onClick={() => reset()}>
          Try again
        </Button>
        <Button asChild variant="outline" className="h-11 sm:h-9">
          <Link href="/">Go to dashboard</Link>
        </Button>
      </div>
    </div>
  );
}
