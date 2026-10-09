import { FormSkeleton } from "@/components/auth/RouteStates";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading billing">
      <Skeleton className="h-7 w-32" />
      <Skeleton className="h-28 w-full" />
      <FormSkeleton rows={2} />
    </div>
  );
}
