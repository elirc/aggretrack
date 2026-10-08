# AggreTrack — Domain Engine (source of truth)

Two layers. **`src/lib/domain/`** = pure functions, no DB, no I/O, fully unit-testable. **`src/lib/services/`** = transactional orchestration over Drizzle; every mutation runs inside ONE `db.transaction` with row locks. Services take `(tx, ctx, input)` where `ctx = { orgId: string; userId: string }`.

## Numeric representation (domain layer)

Floats are forbidden for money/weights. Domain functions use:

```ts
export type Kobo = number;   // integer kobo (safe: 2^53 kobo ≈ ₦90 trillion)
export type Grams = number;  // integer grams; 1 kg = 1000 g. DB numeric(12,3) kg ↔ grams losslessly.
```

`src/lib/domain/units.ts`:
```ts
export function kgToGrams(kg: string | number): Grams   // parse decimal string, round to integer grams; throws on NaN/negative-zero garbage
export function gramsToKg(g: Grams): string              // "96.200" — always 3 decimals, for numeric(12,3) binds
export function roundHalfUpKobo(x: number): Kobo         // Math.floor(x + 0.5) for x >= 0; symmetric for negatives: Math.sign(x)*Math.floor(Math.abs(x)+0.5)
export function formatNaira(kobo: Kobo): string          // "₦12,345.67"
```
Services convert DB strings → grams at the boundary, compute in integers, convert back with `gramsToKg`.

## 1. Net weight & line amount — `src/lib/domain/weights.ts`

```ts
export interface DeductionInput { reason: 'moisture'|'foreign_matter'|'sack_weight'|'other'; grams: Grams }
export function computeNetGrams(grossG: Grams, deductions: DeductionInput[]): Grams
export function computeLineAmountKobo(netG: Grams, pricePerKgKobo: Kobo): Kobo
export function computeSackDeductionGrams(bags: number, sackWeightKgPerBag: string): Grams // bags × bag_type.sack_weight_kg
```
Rules: net = gross − Σ deductions; **throws `DomainError('NET_WEIGHT_NEGATIVE')` if net < 0**; each deduction ≥ 0. Amount = `roundHalfUpKobo(netG * pricePerKgKobo / 1000)` (grams × kobo/kg ÷ 1000 g/kg). Purchase total = Σ line amounts (no re-rounding).

Edge cases: zero deductions → net = gross; deductions exactly = gross → net 0, amount 0 (legal); price 0 → amount 0.

## 2. Stock on hand — sign convention

`on_hand(lot, warehouse) = SUM(stock_movements.kg)` filtered by lot+warehouse. Signs are stored in the rows (enforced by DB CHECK):

| type | sign | written by |
|---|---|---|
| receive | + | receivePurchase |
| transfer_out | − | dispatchTransfer |
| transfer_in | + | receiveTransfer (received_kg, loss nets out globally) |
| dispatch | − | createDispatch |
| return | + | recordReturn |
| adjustment | ± | postAdjustment |

`src/lib/domain/stock.ts`:
```ts
export function sumMovements(movements: { kg: Grams }[]): Grams
export function availableGrams(onHandG: Grams, reservedG: Grams): Grams // max guard: throws if result < 0 (invariant breach)
```

## 3. FIFO allocation — `src/lib/domain/allocation.ts`

```ts
export interface LotAvailability { lotId: string; warehouseId: string; receivedAt: Date; availableG: Grams }
export interface AllocationLine { lotId: string; warehouseId: string; grams: Grams }
export function allocateFifo(requestedG: Grams, lots: LotAvailability[]): AllocationLine[]
export function validateManualAllocation(requestedG: Grams, picks: AllocationLine[], lots: LotAvailability[]): AllocationLine[]
```
FIFO order: `receivedAt` asc, tie-break `lotId` asc (deterministic). Skip lots with availableG ≤ 0. Fill greedily; last lot takes partial. If Σ available < requested → throw `DomainError('INSUFFICIENT_STOCK', { shortfallG })`. Manual: every pick must reference a listed lot with pick.grams ≤ availableG and Σ picks === requestedG.

## 4. Oversell guard (service protocol) — `src/lib/services/allocation.ts`

```ts
export async function reserveForSalesLine(tx, ctx, input: { salesLineId: string; mode: 'fifo'|'manual'; picks?: AllocationLine[] }): Promise<LotAllocation[]>
```
Protocol (THE concurrency recipe — every stock-mutating service follows it):
1. Resolve candidate lot ids (by commodity+grade, org-scoped).
2. `SELECT id FROM lots WHERE id IN (...) ORDER BY id FOR UPDATE` — **ordered by id to prevent deadlock**; this serialises writers per lot set.
3. AFTER locking, aggregate `on_hand` (SUM movements) and `reserved` (SUM lot_allocations status='reserved') per lot+warehouse.
4. Run `allocateFifo`/`validateManualAllocation` on fresh numbers; throws reject the tx → oversell impossible.
5. Insert `lot_allocations` rows (status reserved); update sales_order status; audit log.

Same lock-first pattern in `createDispatch`, `dispatchTransfer`, `postAdjustment` (negative adjustments must not drive on_hand below 0 — check after lock), `receivePurchase` (no check needed, pure inflow).

## 5. Dispatch & delivery — `src/lib/services/dispatch.ts`

`createDispatch(tx, ctx, { salesOrderId, allocationIds, vehicleId, driverId, clientId? })`: lock lots of the allocations; verify all status='reserved'; write one `dispatch` row (id = clientId if offline), `dispatch_lines`, one `stock_movements` row per allocation (type dispatch, kg = −allocation.kg, ref wb/dispatch.id); flip allocations → dispatched; waybill number via counter; enqueue waybill PDF job. `recordDelivery(... { dispatchId, deliveredKg })`: sets delivered_kg, transit_loss_kg = dispatched − delivered, status delivered. Transit loss is reporting-only (stock already left at dispatch).

## 6. Transfers — `src/lib/services/transfers.ts`

- `dispatchTransfer`: lock lots; check available (on_hand − reserved) ≥ line kg at source; write `transfer_out` (−kg) per line; status in_transit.
- `receiveTransfer({ lines: { lineId, receivedKg }[] })`: receivedKg ≤ dispatched kg per line; write `transfer_in` (+receivedKg) at destination; `loss_kg = kg − received_kg` on the line; status received. Loss needs no movement (out > in nets it out of global stock); it appears in shrinkage report as Σ transfer_lines.loss_kg.

## 7. Counts & adjustments — `src/lib/services/counts.ts`, `adjustments.ts`

`postCount`: for each line, `diff_kg = counted − system`; diff 0 → nothing; else create adjustment (reason count_difference, kg = diff, source_count_id). Per adjustment: `|kg| <= org.adjustment_approval_threshold_kg` → auto-approve + post in same tx; else status pending_approval + notification to managers. `postAdjustment` (on approve): lock lot; if kg < 0 assert on_hand + kg ≥ 0; write adjustment movement; status posted. Reject → status rejected, no movement.

## 8. Landed cost — `src/lib/services/landedCost.ts`

```ts
export async function recomputeLandedCost(tx, ctx, lotIds: string[]): Promise<void>
```
Per lot: `landed_cost_per_kg = purchase_price_per_kg + (tripShareKobo + directLotExpensesKobo) / original_kg` stored as numeric(14,4) kobo/kg (4 dp, round half-up at 4th dp).
- `tripShareKobo`: for each **inbound** trip linked (via trip_purchases) to the lot's purchase: share `trip.cost_kobo + Σ expenses(trip_id=trip, category.affects_landed_cost)` across ALL lots of ALL purchases on that trip **by original_kg** using `shareByWeight` (below).
- `directLotExpensesKobo`: Σ expenses attached to this lot with `category.affects_landed_cost = true`.
- **Late-cost rule**: costs may arrive after sales. Recompute updates `lots.landed_cost_per_kg` in place; margin reports always read the CURRENT value — historical margin reports shift, and that is intended. Invoiced amounts never change.
- Triggers: trip create/update/delete-link, qualifying expense create/update. Each trigger calls recompute for affected lots in the same tx.

`src/lib/domain/costSharing.ts`:
```ts
export function shareByWeight(totalKobo: Kobo, items: { id: string; grams: Grams }[]): Map<string, Kobo>
```
Largest-remainder method: raw share = total × g/Σg; floor all; distribute remaining kobo one-by-one to largest fractional remainders (tie → lower id first). **Σ shares === total exactly.** All-zero weights → every share 0 except nothing (return zeros, leave total unshared — caller treats as no-op); single item → gets total.

## 9. Payment allocation — `src/lib/domain/payments.ts` + services

```ts
export interface OpenItem { id: string; date: Date; outstandingKobo: Kobo }
export function allocatePaymentFifo(amountKobo: Kobo, open: OpenItem[]): { allocations: { id: string; amountKobo: Kobo }[]; unallocatedKobo: Kobo }
```
Oldest `date` first (tie → id asc); last allocation partial; leftover returned as `unallocatedKobo` (stored unallocated — appears as credit on statement). Manual override: explicit allocations validated: Σ ≤ payment amount, each ≤ item outstanding.
Services: `recordSupplierPayment` (open items = received purchases with outstanding > 0, outstanding = total − prior allocations − advance offsets), `recordCustomerPayment` (open invoices; update invoice status: paid if outstanding 0, part_paid if 0 < paid < total), `offsetAdvance` (create supplier_advance_offsets rows, oldest purchase first, capped by both advance outstanding and purchase outstanding). All lock their parent rows (`SELECT ... FOR UPDATE` on payment target rows ordered by id).

## 10. Ageing — `src/lib/domain/ageing.ts`

```ts
export type AgeBand = 'd0_30' | 'd31_60' | 'd61_90' | 'd90_plus';
export function ageInDays(asOf: Date, origin: Date): number  // floor((utcMidnight(asOf) − utcMidnight(origin)) / 86_400_000), min 0
export function ageBand(days: number): AgeBand               // 0–30 → d0_30, 31–60, 61–90, ≥91 → d90_plus
export function bucketByAge<T>(items: T[], getDate: (t: T) => Date, getValue: (t: T) => number, asOf: Date): Record<AgeBand, number>
```
Payables origin = purchase_date of received purchases with outstanding > 0 (value = outstanding kobo). Receivables origin = invoice_date, value = outstanding. Stock ageing origin = lot.received_at, value = on-hand kg (and kobo value = on-hand grams × landed_cost_per_kg).

## 11. Margin — `src/lib/domain/margin.ts` + report queries

```ts
export function dispatchedCostKobo(dispatchedG: Grams, landedCostPerKgKobo: number): Kobo // roundHalfUpKobo(g × rate / 1000)
export function computeMargin(revenueKobo: Kobo, costKobo: Kobo, expensesKobo: Kobo): { marginKobo: Kobo; marginPercent: number } // percent = margin/revenue×100, 0 revenue → 0
```
- Per **sale**: revenue = Σ sales_lines.amount_kobo (dispatched portion: Σ over dispatch_lines of kg × line price); cost = Σ over dispatch_lines (kg × lot.landed_cost_per_kg).
- Per **lot**: revenue = Σ dispatch_lines of that lot × their sales_line price; cost = dispatched g × landed rate; expenses = non-landed-cost expenses attached to the lot.
- Per customer / commodity: Σ of their sales margins.

## 12. Gapless numbering — `src/lib/services/numbering.ts`

```ts
export async function nextDocumentNumber(tx, orgId: string, type: DocType, year?: number): Promise<string>
```
Single upsert statement (see DATA-MODEL document_counters). MUST be called inside the caller's transaction (rollback releases the number → gapless). Year = Lagos-calendar year of now (document numbers follow business year): compute via `Intl.DateTimeFormat('en', { timeZone: 'Africa/Lagos', year: 'numeric' })`.
`src/lib/domain/numbering.ts`: `formatDocNumber(prefix: string, year: number, seq: number): string` → `PREFIX-YYYY-NNNNN` (pad 5, grows naturally past 99999).

## 13. Offline sync idempotency — `src/lib/services/sync.ts`

Route handler `POST /api/sync` takes `{ events: SyncEvent[] }`, each `{ id: uuid (client), kind: 'purchase'|'receipt'|'dispatch', payload, clientCreatedAt }`. Per event, in its own tx: `SELECT 1 FROM <table> WHERE id = $id` (after org scope) → exists → return `{ id, status: 'duplicate' }`; else call the SAME service function the online path uses, passing the client id as PK. Response per event: `applied | duplicate | error{message}`. Replaying a batch is always safe; partial failures don't block other events.

## 14. Required unit tests (Definition of Done — exact files)

| file | must prove |
|---|---|
| `src/lib/domain/__tests__/weights.test.ts` | net = gross − deductions; negative net throws; amount rounding half-up (e.g. 96.2 kg × ₦305.555/kg); zero cases |
| `src/lib/domain/__tests__/allocation.test.ts` | oldest-first order; lotId tie-break; multi-lot spill; exact fill; INSUFFICIENT_STOCK with shortfall; manual validation |
| `src/lib/domain/__tests__/costSharing.test.ts` | Σ shares === total always (property-ish loop over odd totals); proportionality; largest-remainder; single/zero-weight |
| `src/lib/domain/__tests__/payments.test.ts` | oldest-first; partial last; overpayment unallocated; empty list |
| `src/lib/domain/__tests__/ageing.test.ts` | boundaries 30/31, 60/61, 90/91; same-day 0; bucket sums |
| `src/lib/domain/__tests__/margin.test.ts` | margin + percent; zero revenue |
| `src/lib/services/__tests__/stock-invariant.test.ts` | after EVERY flow (receive→transfer→count-adjust→reserve→dispatch→return) on_hand === Σ movements and never negative |
| `src/lib/services/__tests__/oversell.test.ts` | two concurrent `reserveForSalesLine` on one lot with available 100: one commits, one rejects (Promise.allSettled over two real connections) |
| `src/lib/services/__tests__/sync-idempotency.test.ts` | same offline purchase event applied twice → exactly one purchase row |
| `src/lib/services/__tests__/numbering.test.ts` | 10 parallel tx → numbers 1..10, no gaps/dupes |
| `src/lib/services/__tests__/tenancy.test.ts` | org B cannot read/mutate org A rows through any service |

Service tests run against a dedicated `aggretrack_test` database, `fileParallelism: false` in vitest config (shared-DB suites must not interleave).
