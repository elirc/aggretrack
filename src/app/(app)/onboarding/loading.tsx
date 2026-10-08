import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4" aria-busy="true" aria-label="Loading setup">
      <Skeleton className="h-7 w-56" />
      <Skeleton className="h-2 w-full" />
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-72 w-full" />
    </div>
  );
}
