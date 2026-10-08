import type { ReactNode } from "react";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-muted/40 px-4 py-8">
      <div className="mb-6 text-center">
        <p className="text-2xl font-bold tracking-tight">AggreTrack</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Buying, warehouse and sales tracking
        </p>
      </div>
      <div className="w-full max-w-sm">{children}</div>
    </div>
  );
}
