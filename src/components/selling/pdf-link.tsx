import { FileDown } from "lucide-react";

import { Button } from "@/components/ui/button";

/** PDF link when the document exists; otherwise a disabled button with a "generating…" hint. */
export function PdfLink({ documentId, label = "PDF" }: { documentId: string | null; label?: string }) {
  if (documentId) {
    return (
      <Button asChild variant="outline" className="h-11 sm:h-9">
        <a href={`/api/documents/${documentId}`} target="_blank" rel="noopener noreferrer">
          <FileDown /> {label}
        </a>
      </Button>
    );
  }
  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      <Button variant="outline" className="h-11 sm:h-9" disabled aria-describedby="pdf-generating">
        <FileDown /> {label}
      </Button>
      <span id="pdf-generating" className="text-xs text-muted-foreground">
        generating… refresh in a moment
      </span>
    </span>
  );
}
