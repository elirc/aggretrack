"use client";

import { useState } from "react";
import { FileSpreadsheet, FileText, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

const ERRORS: Record<string, string> = {
  UNAUTHENTICATED: "Your session has expired. Sign in again.",
  FORBIDDEN: "You don't have permission to export reports.",
  VALIDATION: "Check the report filters and try again.",
  NOT_FOUND: "That report doesn't exist.",
};

function filenameFrom(res: Response, fallback: string): string {
  const cd = res.headers.get("Content-Disposition") ?? "";
  const m = /filename="([^"]+)"/.exec(cd);
  return m ? m[1] : fallback;
}

/**
 * Excel / PDF export for the current report params. The hrefs are real links
 * (/api/exports/<report>?format=…&<params>) so they also work with JS off;
 * with JS we download via fetch to surface errors as toasts.
 */
export function ExportButtons({ report, query }: { report: string; query: string }) {
  const [busy, setBusy] = useState<"xlsx" | "pdf" | null>(null);

  const href = (format: "xlsx" | "pdf") =>
    `/api/exports/${report}?${new URLSearchParams({ format }).toString()}${query ? `&${query}` : ""}`;

  const download = async (e: React.MouseEvent, format: "xlsx" | "pdf") => {
    e.preventDefault();
    if (busy) return;
    setBusy(format);
    const id = toast.loading(format === "xlsx" ? "Preparing Excel export…" : "Preparing PDF…");
    try {
      const res = await fetch(href(format), { credentials: "same-origin" });
      if (!res.ok) {
        let code = "";
        try {
          code = ((await res.json()) as { error?: string }).error ?? "";
        } catch {
          // non-JSON error body
        }
        toast.error(ERRORS[code] ?? "Export failed. Try again.", { id });
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filenameFrom(res, `aggretrack-${report}.${format}`);
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      toast.success("Export downloaded", { id });
    } catch {
      toast.error("Export failed. Check your connection.", { id });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex gap-2">
      <Button asChild variant="outline" size="sm" className="h-9">
        <a href={href("xlsx")} onClick={(e) => download(e, "xlsx")} aria-disabled={busy !== null || undefined}>
          {busy === "xlsx" ? <Loader2 className="animate-spin" /> : <FileSpreadsheet />}
          Excel
        </a>
      </Button>
      <Button asChild variant="outline" size="sm" className="h-9">
        <a href={href("pdf")} onClick={(e) => download(e, "pdf")} aria-disabled={busy !== null || undefined}>
          {busy === "pdf" ? <Loader2 className="animate-spin" /> : <FileText />}
          PDF
        </a>
      </Button>
    </div>
  );
}
