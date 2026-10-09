import Link from "next/link";
import { CloudOff } from "lucide-react";

import { Button } from "@/components/ui/button";

export const metadata = { title: "Offline" };

// Static: precached by the service worker and served when a page isn't cached.
export const dynamic = "force-static";

export default function OfflinePage() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center gap-4 px-4 text-center">
      <CloudOff className="size-12 text-muted-foreground" aria-hidden />
      <h1 className="text-xl font-semibold">You are offline</h1>
      <p className="text-sm text-muted-foreground">
        This page hasn&apos;t been saved on this phone yet. Purchases, receipts and dispatches you already opened
        still work offline — saves are queued and sync when the network is back.
      </p>
      <div className="flex w-full flex-col gap-2 sm:flex-row sm:justify-center">
        <Button asChild className="h-11">
          <Link href="/purchases/new">New purchase</Link>
        </Button>
        <Button asChild variant="outline" className="h-11">
          <Link href="/">Try again</Link>
        </Button>
      </div>
    </main>
  );
}
