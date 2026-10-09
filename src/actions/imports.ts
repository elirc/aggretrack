"use server";

import { revalidatePath } from "next/cache";

import { db } from "@/db/client";
import { orgAction } from "@/lib/authz/guard";
import * as svc from "@/lib/services/imports";
import { enqueuePendingJobs } from "@/lib/services/suppliers";
import { importInput } from "@/lib/validation/imports";

/** CSV import server actions (P4-C). The file travels as text; all parsing is server-side. */

export const previewImportAction = orgAction({
  permission: "import.write",
  schema: importInput,
  handler: (input, ctx) => svc.previewImport(db, ctx, input),
});

export const confirmImportAction = orgAction({
  permission: "import.write",
  schema: importInput,
  handler: async (input, ctx) => {
    const { jobs, ...result } = await svc.confirmImport(db, ctx, input);
    // Every row committed in its own transaction — safe to enqueue now.
    await enqueuePendingJobs(jobs);
    if (result.kind === "suppliers") revalidatePath("/suppliers");
    else if (result.kind === "customers") revalidatePath("/customers");
    else {
      revalidatePath("/stock");
      revalidatePath("/purchases");
    }
    return result;
  },
});
