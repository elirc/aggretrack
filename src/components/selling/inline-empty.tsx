/** Compact empty state for sections and tabs. */
export function EmptyStateInline({ text }: { text: string }) {
  return <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">{text}</p>;
}
