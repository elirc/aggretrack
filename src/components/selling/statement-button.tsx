"use client";

import { FileText } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

/** Customer statement — disabled until the statements wave wires it. */
export function StatementButton() {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} className="inline-flex" aria-label="Statement — coming soon">
            <Button variant="outline" className="h-11 sm:h-9" disabled>
              <FileText /> Statement
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>Printable statements arrive in a later update.</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
