"use client";

import { useState } from "react";
import { Check, ChevronsUpDown, UserPlus } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

import { SupplierForm } from "./supplier-form";

export type SupplierOption = {
  id: string;
  name: string;
  phone: string | null;
  village: string | null;
};

/**
 * Searchable supplier picker. With `allowCreate`, offers an inline
 * "Add new supplier" sheet; the created supplier is selected immediately.
 */
export function SupplierCombobox({
  id,
  options,
  value,
  onChange,
  allowCreate = false,
  invalid,
  placeholder = "Pick a supplier",
}: {
  id?: string;
  options: SupplierOption[];
  value: string;
  onChange: (id: string, option: SupplierOption | null) => void;
  allowCreate?: boolean;
  invalid?: boolean;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [created, setCreated] = useState<SupplierOption[]>([]);
  const all = [...created.filter((c) => !options.some((o) => o.id === c.id)), ...options];
  const selected = all.find((o) => o.id === value) ?? null;

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-invalid={invalid || undefined}
            className={cn("h-12 w-full justify-between px-3 text-left font-normal", !selected && "text-muted-foreground")}
          >
            <span className="min-w-0 truncate">
              {selected ? (
                <>
                  <span className="font-medium text-foreground">{selected.name}</span>
                  {selected.village ? <span className="text-muted-foreground"> · {selected.village}</span> : null}
                </>
              ) : (
                placeholder
              )}
            </span>
            <ChevronsUpDown className="opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-(--radix-popover-trigger-width) min-w-72 p-0" align="start">
          <Command>
            <CommandInput placeholder="Search name, phone or village…" className="h-11" />
            <CommandList className="max-h-72">
              <CommandEmpty>No supplier found.</CommandEmpty>
              <CommandGroup>
                {all.map((o) => (
                  <CommandItem
                    key={o.id}
                    value={`${o.name} ${o.phone ?? ""} ${o.village ?? ""} ${o.id}`}
                    className="min-h-11"
                    onSelect={() => {
                      onChange(o.id, o);
                      setOpen(false);
                    }}
                  >
                    <Check className={cn(o.id === value ? "opacity-100" : "opacity-0")} />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate font-medium">{o.name}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {[o.village, o.phone].filter(Boolean).join(" · ") || "—"}
                      </span>
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
              {allowCreate ? (
                <>
                  <CommandSeparator />
                  <CommandGroup forceMount>
                    <CommandItem
                      value="__add_new_supplier__"
                      forceMount
                      className="min-h-11 font-medium"
                      onSelect={() => {
                        setOpen(false);
                        setSheetOpen(true);
                      }}
                    >
                      <UserPlus /> Add new supplier
                    </CommandItem>
                  </CommandGroup>
                </>
              ) : null}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {allowCreate ? (
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetContent side="bottom" className="max-h-[90dvh] overflow-y-auto px-4 pb-6">
            <SheetHeader className="px-0">
              <SheetTitle>Add supplier</SheetTitle>
              <SheetDescription>Just the basics now — complete the profile later.</SheetDescription>
            </SheetHeader>
            {sheetOpen ? (
              <SupplierForm
                compact
                submitLabel="Add and select"
                onSaved={(s) => {
                  const opt: SupplierOption = {
                    id: s.id,
                    name: s.name,
                    phone: s.values.phone,
                    village: s.values.village,
                  };
                  setCreated((prev) => [opt, ...prev]);
                  onChange(opt.id, opt);
                  setSheetOpen(false);
                }}
                secondary={
                  <Button type="button" variant="outline" className="h-12 sm:h-9" onClick={() => setSheetOpen(false)}>
                    Cancel
                  </Button>
                }
              />
            ) : null}
          </SheetContent>
        </Sheet>
      ) : null}
    </>
  );
}
