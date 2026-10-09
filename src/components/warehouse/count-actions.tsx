"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { cancelCountAction, postCountAction } from "@/actions/counts";

import { runWarehouseAction } from "./run-action";

/** Post / cancel controls for a draft count. Approval split is computed server-side. */
export function CountActions({
  countId,
  canPost,
  canCancel,
  autoCount,
  approvalCount,
}: {
  countId: string;
  canPost: boolean;
  canCancel: boolean;
  /** Lines whose difference is within the threshold (posted immediately). */
  autoCount: number;
  /** Lines whose difference exceeds the threshold (pending approval). */
  approvalCount: number;
}) {
  const router = useRouter();
  const [dialog, setDialog] = useState<"post" | "cancel" | null>(null);
  const [pending, startTransition] = useTransition();

  const changes = autoCount + approvalCount;
  const postText =
    changes === 0
      ? "Every counted lot matches the system. Posting closes the count with no adjustments."
      : [
          autoCount ? `${autoCount} adjustment${autoCount === 1 ? "" : "s"} will post straight away.` : null,
          approvalCount
            ? `${approvalCount} adjustment${approvalCount === 1 ? "" : "s"} will wait for manager approval.`
            : null,
        ]
          .filter(Boolean)
          .join(" ");

  const run = (which: "post" | "cancel") =>
    startTransition(async () => {
      const res =
        which === "post"
          ? await runWarehouseAction(postCountAction, { countId }, "Count posted")
          : await runWarehouseAction(cancelCountAction, { countId }, "Count cancelled");
      setDialog(null);
      if (res.ok) router.refresh();
    });

  if (!canPost && !canCancel) return null;
  return (
    <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
      {canCancel ? (
        <Button variant="outline" className="h-11 sm:h-9" onClick={() => setDialog("cancel")}>
          Cancel count
        </Button>
      ) : null}
      {canPost ? (
        <Button className="h-11 sm:h-9" onClick={() => setDialog("post")}>
          Post count
        </Button>
      ) : null}
      <AlertDialog open={dialog !== null} onOpenChange={(o) => !o && setDialog(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{dialog === "post" ? "Post this count?" : "Cancel this count?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {dialog === "post" ? postText : "The count is kept as cancelled; stock is not changed."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Back</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={(e) => {
                e.preventDefault();
                if (dialog) run(dialog);
              }}
            >
              {pending ? "Working…" : dialog === "post" ? "Post count" : "Cancel count"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
