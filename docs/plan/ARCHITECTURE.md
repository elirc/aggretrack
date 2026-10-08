# AggreTrack — Architecture

Single Next.js app (latest stable, App Router, `src/` dir, TS strict) + one pg-boss worker process (`worker/index.ts`, run with `tsx`) in the same repo. NOT a monorepo: one `package.json`, one `pnpm-lock.yaml`. PostgreSQL via Drizzle ORM (`drizzle-kit` migrations in `drizzle/`). Local dev uses native PG on `localhost:5432`; Docker Compose ships `db` for everyone else.

## Repo layout

```
drizzle/                  # generated SQL migrations (drizzle-kit)
scripts/                  # create-dbs.ts, seed.ts, seed-data/
worker/                   # pg-boss worker process
  index.ts                # boots pg-boss, registers all handlers
  jobs/                   # documents.ts, sms.ts, alerts.ts, billing.ts
e2e/                      # Playwright specs
tests/
  unit/                   # pure domain tests, NO database
  integration/            # DB-backed service tests (per-agent DB, see TASKS)
src/
  app/                    # routes (map below)
  db/
    client.ts             # drizzle singleton (pg Pool), tx helper
    index.ts              # re-export schema + client
    schema/               # auth.ts, org.ts, master.ts, suppliers.ts, buying.ts,
                          # stock.ts, selling.ts, logistics.ts, billing.ts, system.ts
  lib/
    domain/               # PURE functions, no IO. units.ts (kobo/gram converters),
                          # netWeight.ts, fifo.ts, landedCost.ts, paymentAllocation.ts,
                          # ageing.ts, margin.ts, format.ts (₦, kg, Lagos dates)
    services/             # transactional business logic; every fn takes (ctx, input)
                          # stockCore.ts + numbering.ts are the shared spine (see below)
    auth/                 # auth.ts (betterAuth server), client.ts, otp.ts (rate limit)
    authz/                # permissions.ts (matrix), guard.ts (orgAction), context.ts
    audit/audit.ts        # writeAudit(tx, ctx, {entity, entityId, action, before, after})
    validation/           # zod schemas per module, imported by both forms and actions
    jobs.ts               # queue-name constants + payload types (shared web/worker)
    export/               # excel.ts (ExcelJS builders), reportPdf.tsx
    test/                 # integration test harness: setup.ts, factories.ts
  actions/                # server actions per module ("use server"), thin: guard → service
  adapters/               # sms/ email/ payments/ storage/ — each: types.ts, mock.ts,
                          # <real>.ts, index.ts factory reading env
  components/
    ui/                   # shadcn/ui (generated)
    layout/               # AppShell, MobileNav, nav-items.ts, OrgSwitcher, PageHeader
    auth/ buying/ warehouse/ selling/ logistics/ reports/ notifications/ shared/
  offline/                # db.ts (Dexie), outbox.ts, sync-client.ts, useOutbox.ts
  pdf/                    # grn.tsx, waybill.tsx, invoice.tsx, supplier-statement.tsx,
                          # customer-statement.tsx, components.tsx, render.ts
  app/sw.ts               # Serwist service worker entry
```

## Route map (src/app)

```
(auth)/login              phone-OTP first, email+password tab
(auth)/verify             OTP code entry (mock mode hint: 123456)
(auth)/register           account + organisation create → /onboarding
api/auth/[...all]         Better Auth handler
api/health                { ok, db, version }
api/sync                  POST — offline outbox ingest (idempotent)
api/webhooks/paystack     POST — signature-verified
api/documents/[id]        GET — stream stored PDF (authz checked)
api/exports/[report]      GET — Excel/PDF download (authz checked)

(app)/ — requires session + active org membership; layout = AppShell
  page.tsx                          dashboard (cards, charts, alerts)
  onboarding/                       wizard: commodities → grades → bag types →
                                    warehouses → buying points → users
  suppliers/  suppliers/new  suppliers/[id]        (profile, history, deductions,
                                                    advances, balance, statement btn)
  purchases/  purchases/new  purchases/[id]        (quick entry; detail: approve, receive→GRN)
  advances/                                        list + record advance
  supplier-payments/                               record + allocate
  payables/                                        ageing table
  price-guides/                                    per day/commodity/point entry
  stock/                                           position by commodity/grade/warehouse
  stock/lots/[id]                                  lot page: cost, movements, trace
  stock/ageing/                                    0-30/31-60/61-90/90+ bands
  movements/                                       filterable history
  transfers/  transfers/new  transfers/[id]        dispatch → in-transit → receive (loss)
  counts/  counts/new  counts/[id]                 enter counts, variance, post adjustments
  adjustments/                                     list + approval queue
  customers/  customers/[id]                       profile, invoices, statement
  sales/  sales/new  sales/[id]                    lines, allocation (auto FIFO / manual)
  dispatches/[id]                                  waybill, delivered-weight entry
  invoices/  invoices/[id]                         PDF, payments
  customer-payments/                               record + allocate
  receivables/                                     ageing table
  trips/  trips/new  trips/[id]                    link purchases/dispatches, costs
  expenses/                                        list + record (lot/trip/warehouse link)
  alerts/                                          notification centre
  reports/                                         index
  reports/[report]                                 purchases|stock-position|movements|sales|
                                                   margin|payables-ageing|receivables-ageing|
                                                   supplier-performance|losses|trip-costs
  settings/                                        org profile, approval thresholds
  settings/master-data/                            tabs: commodities, grades, bag types,
                                                   warehouses+bins, buying points, vehicles,
                                                   drivers, expense categories
  settings/users/                                  members, invites, roles, restrictions,
                                                   hide-prices switch
  settings/billing/                                plan, trial state, Paystack checkout
  settings/import/                                 CSV import: suppliers, customers,
                                                   opening stock (preview + row errors)
  settings/audit/                                  audit log browser

(platform)/ — platform_admin flag only; own layout
  platform/                         health overview
  platform/organisations/  [id]     usage, subscription, read-only toggle
  platform/plans/                   CRUD plans
  platform/audit/                   cross-tenant audit
```

## Auth & authz

- Better Auth with `phoneNumber` plugin (OTP via SMS adapter), email+password, and `organization` plugin. Verify exact plugin APIs against the installed `better-auth` package docs before coding — do not guess.
- `sendOTP` callback → `getSmsAdapter().send(...)`. Mock SMS driver returns OTP `123456` and logs to console; `otp.ts` rate-limits to 3 requests per phone per 10 min (counter table `otp_throttle`).
- Org membership: organization-plugin member table with custom role strings; our own `member_settings` table adds `warehouse_ids text[] | null`, `buying_point_ids text[] | null`, `hide_prices boolean`.
- Roles: `owner | manager | procurement | warehouse | sales | accountant`. Platform admin = `users.is_platform_admin` boolean, independent of org roles.
- `src/lib/authz/permissions.ts`: `type Permission = 'supplier.read' | 'purchase.create' | 'purchase.approve' | ...` (string union, one per guarded capability); `const ROLE_PERMISSIONS: Record<Role, readonly Permission[] | '*'>`. Mutating permissions are the ones not ending in `.read`/`.export`.
- Startup refusal: `instrumentation.ts` throws when `APP_ENV === 'production'` and any adapter driver is `mock`. Compose demo runs with `APP_ENV=demo` (mock adapters allowed, NODE_ENV=production fine).

### The action guard (every server action goes through it)

```ts
// src/lib/authz/guard.ts
export type OrgContext = {
  orgId: string; userId: string; role: Role;
  restrictions: { warehouseIds: string[] | null; buyingPointIds: string[] | null; hidePrices: boolean };
  readOnly: boolean;            // true after trial expiry / failed payment
};
export type ActionResult<R> =
  | { ok: true; data: R }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

export function orgAction<S extends z.ZodType, R>(opts: {
  permission: Permission;
  schema: S;
  handler: (input: z.output<S>, ctx: OrgContext) => Promise<R>;
}): (raw: z.input<S>) => Promise<ActionResult<R>>;
```

Guard steps, in order: resolve session (Better Auth) → resolve active org + membership server-side (NEVER from client input) → permission check → if permission mutates and `ctx.readOnly`, reject with "Subscription inactive — read only" → `schema.safeParse` → run handler → map thrown `DomainError(code, message)` to `{ok:false}`. Services write audit rows inside their own transaction. A twin `platformAction` guard checks `is_platform_admin`.

Restriction enforcement: guard injects `ctx.restrictions`; services apply them as query filters (warehouse-scoped lists) and creation checks (procurement can only buy at allowed buying points). `hidePrices` is honoured by read services (strip price fields) AND by UI, but server-side stripping is the real control.

## Multi-tenancy

Every business table has `org_id` (FK → organisations, indexed, part of every unique constraint that must be per-org). Services never accept `orgId` from input payloads — only from `ctx`. `tests/integration/tenancy.test.ts` creates two orgs and asserts every list/get service returns zero rows across tenants and every mutation on a foreign-org id throws NotFound.

## Stock spine (pre-written, shared)

```ts
// src/lib/services/stockCore.ts — the ONLY code that inserts stock_movements
export type MovementInput = { lotId: string; warehouseId: string; binId?: string | null;
  type: 'receive'|'transfer_out'|'transfer_in'|'adjustment'|'dispatch'|'return';
  grams: number;            // signed: receive/transfer_in/return > 0; out/dispatch < 0; adjustment either
  bags: number;             // signed likewise
  refType: string; refId: string };
export async function postMovements(tx: Tx, ctx: OrgContext, moves: MovementInput[]): Promise<void>;
// Locks each affected lot row (SELECT ... FOR UPDATE ORDER BY lot id to avoid deadlock),
// computes on-hand = SUM(movements) per lot+warehouse, subtracts active reservations
// (lot_allocations status='reserved') for outgoing moves, throws DomainError('INSUFFICIENT_STOCK')
// if any balance would go negative. Append-only; corrections are new movements.
export async function lotOnHand(dbOrTx, ctx, lotId): Promise<{grams: number; bags: number}>;
export async function availableGrams(tx, ctx, lotId, warehouseId): Promise<number>;
```

```ts
// src/lib/services/numbering.ts — gapless per org/type/year
export async function nextDocNumber(tx: Tx, orgId: string,
  type: 'GRN'|'WB'|'INV'|'PO'|'TRF'|'ADJ'|'CNT'|'PAY'|'EXP'|'TRP'): Promise<string>;
// document_counters (org_id, doc_type, year, last_no) UPDATE ... RETURNING under the
// caller's tx row lock → "GRN-2026-00001". Must be called inside the same tx that
// creates the document row, so numbers stay gapless.
```

Money = integer kobo (`bigint` column, `mode:'number'`). Weight = integer grams in domain math; DB `numeric(12,3)` kg columns with converter helpers `kgStrToGrams` / `gramsToKgStr` in `src/lib/domain/units.ts`. Timestamps `timestamptz` UTC; display via `format.ts` in Africa/Lagos.

## Adapters

```ts
// each of sms/ email/ payments/ storage/
export interface SmsAdapter { send(to: string, body: string): Promise<{id: string}> }
// payments: createPlan, initializeSubscription(email, planCode, orgId) → {checkoutUrl},
//           verifyWebhook(rawBody, signature) → event | null, cancelSubscription
// storage:  put(key, buf, contentType) → {key}, get(key) → Buffer, url(key)
// factory:  export function getSmsAdapter(): SmsAdapter  — switches on process.env.SMS_DRIVER
```

Drivers by env: `SMS_DRIVER=mock|termii`, `EMAIL_DRIVER=mock|resend`, `PAYMENTS_DRIVER=mock|paystack`, `STORAGE_DRIVER=local|s3`. Mock drivers log + return deterministic values (and record into `notifications` table where relevant). Real drivers follow `docs/plan/INTEGRATIONS.md` (checked against live docs); Paystack webhook = HMAC-SHA512 of raw body with secret key compared to `x-paystack-signature`.

## Offline / PWA

- Serwist wired in `next.config.ts` + `src/app/sw.ts`; app manifest → installable; app shell + static assets precached; GET pages network-first.
- Dexie DB `aggretrack-offline`: table `outbox` `{ id: string /* client uuid, PK */, kind: 'purchase'|'receipt'|'dispatch', payload: unknown, status: 'pending'|'syncing'|'failed', error?: string, createdAt: number }` plus `refData` cache (suppliers, commodities, grades, bag types, buying points, warehouses) refreshed on each online load so the purchase form works offline.
- Forms that work offline (purchase quick-entry, receipt, dispatch) generate a client UUID at mount, submit to the outbox when `navigator.onLine === false` (or server action fails with network error), and show a "Queued — will sync" state.
- `POST /api/sync` body: `{ ops: Array<{ clientId: string; kind: string; payload: unknown }> }`. Server validates each payload with the same zod schema as the online action, runs the same service, and relies on a UNIQUE `(org_id, client_id)` on purchases/receipts/dispatches: on conflict → return `{ clientId, status: 'duplicate' }`. Response: per-op `applied | duplicate | error(message)`. Client marks outbox rows done/failed. Replaying the whole batch is always safe (DoD test).
- Online actions ALSO pass the client uuid through to the same services, so online+offline retries share one idempotency path.

## Billing / read-only

`subscriptions` row per org: `status: 'trialing'|'active'|'past_due'|'canceled'`, `trial_ends_at`, `plan_id`, `paystack_*` refs. `ctx.readOnly = !(status in ('trialing' with trial_ends_at>now, 'active'))`. Enforced in ONE place: the guard (mutating permissions rejected). UI shows a banner via layout query. Paystack webhook events update status; nightly worker job expires trials. Orgs are never deleted.

## Worker (pg-boss)

Queues in `src/lib/jobs.ts`: `document.generate` (render react-pdf → storage → documents row), `sms.send`, `email.send`, `alerts.scan` (cron ~15 min: low stock, old stock, near-capacity → notifications), `billing.sweep` (cron daily: trial expiry, past-due). Web enqueues; worker executes. pg-boss uses the same DATABASE_URL (its own schema `pgboss`).

## Env (.env.example)

```
DATABASE_URL=postgres://postgres:postgres@localhost:5432/aggretrack_dev
APP_ENV=development            # development | demo | production
BETTER_AUTH_SECRET=change-me
BETTER_AUTH_URL=http://localhost:3000
NEXT_PUBLIC_APP_URL=http://localhost:3000
SMS_DRIVER=mock                # mock | termii
TERMII_API_KEY= TERMII_SENDER_ID=
EMAIL_DRIVER=mock              # mock | resend
RESEND_API_KEY= EMAIL_FROM=ops@example.com
PAYMENTS_DRIVER=mock           # mock | paystack
PAYSTACK_SECRET_KEY= PAYSTACK_PUBLIC_KEY=
STORAGE_DRIVER=local           # local | s3
STORAGE_LOCAL_DIR=./storage
S3_ENDPOINT= S3_REGION= S3_BUCKET= S3_ACCESS_KEY_ID= S3_SECRET_ACCESS_KEY=
```

## Docker Compose

`db` (postgres:18-alpine, healthcheck, volume) → `web` (multi-stage Dockerfile, `next start`, runs migrations on boot) + `worker` (same image, `node worker`). `docker compose up` + `pnpm seed` = DoD demo. Local dev: native PG 5432, `pnpm dev` and `pnpm worker:dev`.

## Testing

- `tests/unit`: pure domain, no DB, runs anywhere.
- `tests/integration`: real PG. DB name from `TEST_DB_NAME` env (default `aggretrack_test`); harness `src/lib/test/setup.ts` creates/pushes schema once per run, truncates between files; `fileParallelism: false`. Each parallel implementer agent is ASSIGNED its own DB (`aggretrack_test_1..4`) — never share.
- `e2e/`: Playwright vs `next dev` on `aggretrack_e2e` DB, seeded. Orchestrator-only.
- UI rules every page must meet: works at 360 px, loading/empty/error states, prices hidden when `hidePrices`.
