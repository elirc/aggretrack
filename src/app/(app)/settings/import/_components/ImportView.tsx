"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Download, Loader2 } from "lucide-react";

import { confirmImportAction, previewImportAction } from "@/actions/imports";
import { actionErrorMessage } from "@/components/auth/messages";
import type { ImportPreview, ImportResult } from "@/lib/services/imports";
import type { ImportKind } from "@/lib/validation/imports";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const KINDS: { kind: ImportKind; label: string; help: string }[] = [
  {
    kind: "suppliers",
    label: "Suppliers",
    help: "Columns: name (required), type (farmer/agent/cooperative, default farmer), phone, village, lga, state, bank_name, bank_account_number, bank_account_name. Same name + phone as an existing supplier is skipped.",
  },
  {
    kind: "customers",
    label: "Customers",
    help: "Columns: name (required), phone, email, address, state. Same name + phone as an existing customer is skipped.",
  },
  {
    kind: "opening_stock",
    label: "Opening stock",
    help: "Columns (all required): supplier_name_or_new, commodity_code, grade_name, warehouse_name, bags, net_kg, price_per_kg_naira, received_date (yyyy-mm-dd). Each row becomes a received purchase with its own lot and GRN.",
  },
];

const PREVIEW_LIMIT = 50;

type ImportOutcome = Omit<ImportResult, "jobs">;

export function ImportView({ templates }: { templates: Record<ImportKind, string> }) {
  return (
    <Tabs defaultValue="suppliers">
      <TabsList className="w-full sm:w-auto">
        {KINDS.map((k) => (
          <TabsTrigger key={k.kind} value={k.kind}>
            {k.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {KINDS.map((k) => (
        <TabsContent key={k.kind} value={k.kind} className="pt-4">
          <ImportPanel kind={k.kind} label={k.label} help={k.help} template={templates[k.kind]} />
        </TabsContent>
      ))}
    </Tabs>
  );
}

function ImportPanel({
  kind,
  label,
  help,
  template,
}: {
  kind: ImportKind;
  label: string;
  help: string;
  template: string;
}) {
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string>("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [result, setResult] = useState<ImportOutcome | null>(null);
  const [pending, startTransition] = useTransition();

  async function onFile(file: File | undefined) {
    setPreview(null);
    setResult(null);
    if (!file) {
      setCsv(null);
      setFileName("");
      return;
    }
    setFileName(file.name);
    setCsv(await file.text());
  }

  function runPreview() {
    if (!csv) return;
    startTransition(async () => {
      const res = await previewImportAction({ kind, csv });
      if (!res.ok) {
        toast.error(res.fieldErrors?.csv?.[0] ?? actionErrorMessage(res.error));
        return;
      }
      setPreview(res.data);
      setResult(null);
    });
  }

  function runConfirm() {
    if (!csv) return;
    startTransition(async () => {
      const res = await confirmImportAction({ kind, csv });
      if (!res.ok) {
        toast.error(actionErrorMessage(res.error));
        return;
      }
      setResult(res.data);
      setPreview(null);
      toast.success(`${res.data.created} imported, ${res.data.skipped} skipped, ${res.data.failed} failed`);
    });
  }

  const templateHref = `data:text/csv;charset=utf-8,${encodeURIComponent(`${template}\n`)}`;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{help}</p>
      <a
        href={templateHref}
        download={`${kind}-template.csv`}
        className="inline-flex items-center gap-1 text-sm font-medium text-primary underline-offset-4 hover:underline"
      >
        <Download className="size-4" aria-hidden /> Download {label.toLowerCase()} template
      </a>

      <div className="space-y-2">
        <Label htmlFor={`csv-${kind}`}>CSV file</Label>
        <Input
          id={`csv-${kind}`}
          type="file"
          accept=".csv,text/csv"
          className="h-11"
          onChange={(e) => void onFile(e.target.files?.[0])}
        />
        {fileName ? <p className="text-xs text-muted-foreground">{fileName}</p> : null}
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <Button className="h-11" onClick={runPreview} disabled={!csv || pending}>
          {pending && !preview ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          Preview
        </Button>
        {preview && preview.validRows.length > 0 ? (
          <Button className="h-11" variant="default" onClick={runConfirm} disabled={pending}>
            {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            Import {preview.validRows.length} valid row{preview.validRows.length === 1 ? "" : "s"}
          </Button>
        ) : null}
      </div>

      {preview ? <PreviewPanel preview={preview} /> : null}
      {result ? <ResultPanel result={result} /> : null}
    </div>
  );
}

function rowSummary(p: ImportPreview, i: number): { row: number; text: string; notice?: string } {
  switch (p.kind) {
    case "suppliers": {
      const r = p.validRows[i];
      return { row: r.row, text: `${r.data.name} · ${r.data.type}${r.data.phone ? ` · ${r.data.phone}` : ""}`, notice: r.notice };
    }
    case "customers": {
      const r = p.validRows[i];
      return { row: r.row, text: `${r.data.name}${r.data.phone ? ` · ${r.data.phone}` : ""}`, notice: r.notice };
    }
    case "opening_stock": {
      const r = p.validRows[i];
      return {
        row: r.row,
        text: `${r.data.supplierName} · ${r.data.commodityCode} ${r.data.gradeName} · ${r.data.netKg} kg → ${r.data.warehouseName} (${r.data.receivedDate})`,
        notice: r.notice,
      };
    }
  }
}

function PreviewPanel({ preview }: { preview: ImportPreview }) {
  const shown = Math.min(preview.validRows.length, PREVIEW_LIMIT);
  return (
    <div className="space-y-4">
      <Alert variant={preview.errors.length > 0 ? "destructive" : "default"}>
        <AlertTitle>
          {preview.validRows.length} of {preview.totalRows} row{preview.totalRows === 1 ? "" : "s"} ready to import
        </AlertTitle>
        <AlertDescription>
          {preview.errors.length > 0
            ? `${preview.errors.length} problem${preview.errors.length === 1 ? "" : "s"} found — rows with errors are left out. Fix the file and preview again, or import the valid rows now.`
            : "No problems found."}
        </AlertDescription>
      </Alert>

      {preview.errors.length > 0 ? <ErrorTable errors={preview.errors} /> : null}

      {shown > 0 ? (
        <div className="space-y-2">
          <h3 className="text-sm font-medium">
            Valid rows{preview.validRows.length > shown ? ` (first ${shown})` : ""}
          </h3>
          <ul className="divide-y rounded-lg border text-sm">
            {Array.from({ length: shown }, (_, i) => {
              const s = rowSummary(preview, i);
              return (
                <li key={s.row} className="flex flex-col gap-1 px-3 py-2 sm:flex-row sm:items-center sm:gap-3">
                  <span className="w-14 shrink-0 text-xs text-muted-foreground">Row {s.row}</span>
                  <span className="flex-1">{s.text}</span>
                  {s.notice ? <Badge variant="secondary">{s.notice}</Badge> : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function ErrorTable({ errors }: { errors: { row: number; field: string; message: string }[] }) {
  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-16">Row</TableHead>
            <TableHead className="w-40">Column</TableHead>
            <TableHead>Problem</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {errors.slice(0, 200).map((e, i) => (
            <TableRow key={`${e.row}-${e.field}-${i}`}>
              <TableCell>{e.row > 0 ? e.row : "—"}</TableCell>
              <TableCell className="font-mono text-xs">{e.field}</TableCell>
              <TableCell className="whitespace-normal">{e.message}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {errors.length > 200 ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">…and {errors.length - 200} more</p>
      ) : null}
    </div>
  );
}

const OUTCOME_VARIANT = { created: "default", skipped: "secondary", failed: "destructive" } as const;

function ResultPanel({ result }: { result: ImportOutcome }) {
  return (
    <div className="space-y-3">
      <Alert>
        <AlertTitle>Import finished</AlertTitle>
        <AlertDescription>
          {result.created} created · {result.skipped} skipped · {result.failed} failed
          {result.invalid > 0 ? ` · ${result.invalid} invalid row${result.invalid === 1 ? "" : "s"} not attempted` : ""}
        </AlertDescription>
      </Alert>
      {result.outcomes.length > 0 ? (
        <ul className="divide-y rounded-lg border text-sm">
          {result.outcomes.map((o) => (
            <li key={o.row} className="flex flex-col gap-1 px-3 py-2 sm:flex-row sm:items-center sm:gap-3">
              <span className="w-14 shrink-0 text-xs text-muted-foreground">Row {o.row}</span>
              <Badge variant={OUTCOME_VARIANT[o.status]} className="w-fit">
                {o.status}
              </Badge>
              <span className="flex-1">{o.message}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {result.errors.length > 0 ? <ErrorTable errors={result.errors} /> : null}
    </div>
  );
}
