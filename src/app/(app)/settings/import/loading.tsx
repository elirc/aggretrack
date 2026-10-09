import { FormSkeleton } from "@/components/auth/RouteStates";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading import">
      <Skeleton className="h-7 w-36" />
      <Skeleton className="h-10 w-full sm:w-96" />
      <FormSkeleton rows={1} />
    </div>
  );
}
