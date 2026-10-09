"use client";

import { FileText } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Supplier statement button — placeholder until P4-D wires statement
 * generation (src/actions/statements.ts). Disabled with an explanatory tooltip.
 */
export function SupplierStatementButton({ supplierId }: { supplierId: string }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          {/* A disabled button swallows pointer events — the span carries the tooltip. */}
          <span tabIndex={0} className="inline-flex" data-supplier-id={supplierId}>
            <Button variant="outline" className="h-11 sm:h-9" disabled aria-disabled>
              <FileText /> Statement
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>coming in a later update</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
