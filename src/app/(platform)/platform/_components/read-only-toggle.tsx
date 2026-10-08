"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { setOrganisationReadOnlyAction } from "@/actions/platform";
import { Switch } from "@/components/ui/switch";
import { actionErrorMessage } from "@/app/(app)/settings/master-data/_components/form-kit";

export function ReadOnlyToggle({
  organisationId,
  readOnly,
  disabled,
}: {
  organisationId: string;
  readOnly: boolean;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <label className="flex items-center gap-3">
      <Switch
        checked={readOnly}
        disabled={disabled || pending}
        aria-label="Read only"
        onCheckedChange={(v) =>
          startTransition(async () => {
            const res = await setOrganisationReadOnlyAction({ organisationId, readOnly: v });
            if (res.ok) {
              toast.success(v ? "Organisation is now read only (past due)" : "Organisation re-activated");
              router.refresh();
            } else {
              toast.error(actionErrorMessage(res.error));
            }
          })
        }
      />
      <span className="text-sm">
        {readOnly ? "Read only" : "Writable"}
        <span className="block text-xs text-muted-foreground">
          On sets the subscription to past due; off sets it to active.
        </span>
      </span>
    </label>
  );
}
