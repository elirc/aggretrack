"use client";

import { toast } from "sonner";

import type { ActionResult } from "@/lib/authz/guard";

import { warehouseErrorMessage } from "./format";

/** Call a server action; toast on success/failure; return the result. */
export async function runWarehouseAction<I, R>(
  action: (raw: I) => Promise<ActionResult<R>>,
  input: I,
  success?: string,
): Promise<ActionResult<R>> {
  let res: ActionResult<R>;
  try {
    res = await action(input);
  } catch {
    res = { ok: false, error: "INTERNAL" };
  }
  if (res.ok) {
    if (success) toast.success(success);
  } else {
    toast.error(warehouseErrorMessage(res.error));
  }
  return res;
}
