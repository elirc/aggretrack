# AggreTrack — Execution Plan (waves + work packages)

Read `docs/SPEC.md` and `docs/plan/ARCHITECTURE.md` first. This file is the fan-out contract: each package lists EXACT file ownership. Ownership is per-wave and disjoint within a wave; a later wave may be granted files from an earlier wave only where listed under GRANTED.

## Global rules for every implementer agent

1. NEVER run `pnpm install`, `pnpm add`, `npx`, `pnpm dlx`, the dev server, Playwright, drizzle-kit, or docker. Dependencies are already installed; missing-dep problems → STOP and report.
2. Write ONLY files you own. You may read anything. If you believe you must edit a file you don't own, STOP and report why instead.
3. Gates you run yourself: `pnpm exec tsc --noEmit` (whole repo must stay clean) and ONLY your own test files via `pnpm exec vitest run <paths>`. Integration tests: set your assigned DB first, PowerShell: `$env:TEST_DB_NAME='aggretrack_test_N'; pnpm exec vitest run tests/integration/<file>`. Never run the whole suite, never another agent's files.
4. Run flaky-looking suites twice; report BOTH results.
5. Report format: files written; commands run with exact exit codes and pass/fail counts; anything you could not do. Never claim a gate you didn't run.
6. Conventions: money = integer kobo (`number`), weights = integer grams in domain/service code, kg strings only at DB/UI edges via `src/lib/domain/units.ts`; every service takes `(ctx: OrgContext, input)` and scopes by `ctx.orgId`; every mutation goes through `orgAction` guard + writes audit via `writeAudit`; every doc number via `nextDocNumber` inside the creating tx; ALL stock_movements inserts via `stockCore.postMovements` — never direct.
7. UI: mobile-first 360 px, shadcn/ui components from `src/components/ui`, every page has loading.tsx/empty/error states, react-hook-form + zodResolver with schemas from `src/lib/validation`, server components for reads + server actions for mutations, TanStack Table for lists (with mobile card fallback), prices hidden when `ctx.restrictions.hidePrices`.

## Wave 0 — Orchestrator pre-writes (no agents)

Scaffold + install (ONE serialized install), then: all config files (`package.json`, `tsconfig.json`, `next.config.ts`, eslint, prettier, `drizzle.config.ts`, `vitest.config.ts`, `playwright.config.ts`, Docker files, `.env.example`, `instrumentation.ts`); ENTIRE `src/db/**` (schema for every table, client, tx helper); `src/lib/auth/**`, `src/lib/authz/**`, `src/lib/audit/**`, `src/lib/domain/units.ts`, `src/lib/services/stockCore.ts`, `src/lib/services/numbering.ts`, `src/lib/validation/common.ts`, `src/lib/jobs.ts`, `src/adapters/**` (interfaces + mock drivers + real-driver skeletons), `src/components/ui/**` (shadcn), `src/components/layout/**` (AppShell, MobileNav, nav-items.ts, PageHeader, OrgSwitcher), root + group layouts, `api/auth/[...all]`, `api/health`, `src/lib/test/**` (integration harness + factories), `worker/index.ts` + `worker/boss.ts` stubs, `scripts/create-dbs.ts`, Serwist skeleton wiring. Databases `aggretrack_dev`, `aggretrack_test`, `aggretrack_test_1..4`, `aggretrack_e2e` created.

## Wave 1 — 4 agents (phase 1 + shared verticals)

### P1-A Auth screens + users/roles
- OWNS: `src/app/(auth)/**` (login, verify, register pages + their components), `src/components/auth/**`, `src/app/(app)/settings/users/**`, `src/app/(app)/settings/page.tsx`, `src/actions/users.ts`, `src/actions/org.ts`, `src/lib/services/users.ts`, `src/lib/validation/users.ts`, `tests/integration/users.test.ts`
- READS: lib/auth, authz, db, ui kit.
- Scope: phone-OTP login (mock hint 123456), email/password, register→create org→redirect /onboarding; members list, invite, role change, warehouse/buying-point restriction editor, hide-prices switch; org settings page (name, approval thresholds).
- GATE: tsc; vitest users.test.ts on `aggretrack_test_1`.

### P1-B Master data + onboarding wizard + platform admin
- OWNS: `src/lib/services/masterData.ts`, `src/lib/services/platform.ts`, `src/lib/validation/masterData.ts`, `src/actions/master-data.ts`, `src/actions/platform.ts`, `src/app/(app)/onboarding/**`, `src/app/(app)/settings/master-data/**`, `src/app/(platform)/**` (pages only; layout exists), `tests/integration/master-data.test.ts`, `tests/integration/tenancy.test.ts`
- Scope: CRUD for commodities, grades, bag types, warehouses+bins, buying points, vehicles, drivers, expense categories; stepper wizard writing the same services; platform pages (orgs list/detail, plans CRUD, cross-tenant audit, health). Tenancy test = two orgs, prove zero cross-reads on every wave-1 service + a foreign-id mutation throws.
- GATE: tsc; its two test files on `aggretrack_test_2`.

### P1-C Domain core (pure) + unit tests
- OWNS: `src/lib/domain/netWeight.ts`, `fifo.ts`, `landedCost.ts`, `paymentAllocation.ts`, `ageing.ts`, `margin.ts`, `format.ts`, `tests/unit/*.test.ts` (one per file)
- Scope: net kg from gross−deductions + line amount (kobo, round half-up per kg price × grams/1000); FIFO allocator `allocate(requestGrams, lots: {lotId, receivedAt, availableGrams}[]) → {lotId, grams}[]`; landed-cost sharing of a cost pool across lots by weight (largest-remainder so kobo sum exactly); payment allocation oldest-first across advances/purchases (and invoices) with explicit override; ageing band bucketing (0-30/31-60/61-90/90+); margin = revenue − landedCost − attachedExpenses; ₦/kg/date-Lagos formatters.
- GATE: tsc; `pnpm exec vitest run tests/unit` (no DB).

### P1-D PDF templates + documents service + worker handlers
- OWNS: `src/pdf/**`, `src/lib/services/documents.ts`, `worker/jobs/documents.ts`, `worker/jobs/sms.ts`, `worker/jobs/alerts.ts` (skeleton scan), `worker/jobs/billing.ts` (skeleton sweep), `tests/unit/pdf.test.ts`
- Scope: GRN, waybill, invoice, supplier statement, customer statement templates taking fully-typed props (no DB reads inside templates); `render.ts` → Buffer; documents.ts stores via storage adapter + inserts documents row; job handlers wire queue payloads from `src/lib/jobs.ts` to render/send. PDF smoke test renders each template to a non-empty buffer.
- GATE: tsc; vitest pdf.test.ts.

## Wave 2 — 4 backend agents (services + actions + validation + integration tests)

### P2-A Buying backend
- OWNS: `src/lib/validation/buying.ts`, `src/lib/services/suppliers.ts`, `priceGuides.ts`, `purchases.ts`, `receiving.ts`, `advances.ts`, `supplierPayments.ts`, `payables.ts`, `src/actions/suppliers.ts`, `price-guides.ts`, `purchases.ts`, `advances.ts`, `supplier-payments.ts`, `tests/integration/purchases.test.ts`, `receiving.test.ts`, `supplier-payments.test.ts`, `payables.test.ts`
- Scope: suppliers CRUD + balance; price guides; purchase create (client uuid idempotency, lines via domain netWeight, over-guide → status pending_approval, approve/reject permission `purchase.approve`); receive → creates lots (cost/kg = line price; landed = cost until trips) + `postMovements(receive)` + GRN number + enqueue `document.generate` + optional `sms.send`; advances; supplier payments with `paymentAllocation` domain fn + allocations rows; payables ageing query (uses domain ageing).
- GATE: tsc; its 4 test files on `aggretrack_test_1`.

### P2-B Warehouse backend
- OWNS: `src/lib/validation/warehouse.ts`, `src/lib/services/stockQueries.ts`, `transfers.ts`, `counts.ts`, `adjustments.ts`, `alertRules.ts`, `src/actions/stock.ts`, `transfers.ts`, `counts.ts`, `adjustments.ts`, `tests/integration/transfers.test.ts`, `counts.test.ts`, `adjustments.test.ts`, `stock-invariant.test.ts`
- Scope: stock position/drill-down/ageing/movement-history queries (value from lot landed cost; respect warehouse restrictions + hidePrices); transfers with in-transit (transfer_out at dispatch, transfer_in at receive, loss = adjustment movement); counts + variance → adjustments; adjustments with approval threshold (org setting, default 50kg) and permission `adjustment.approve`; alertRules = pure-ish scan queries used by worker. stock-invariant.test: after a scripted mix of flows, for every lot×warehouse on-hand == SUM(movements); plus CONCURRENT outgoing movements on one lot (Promise.all of two txs) → exactly one succeeds when stock only covers one.
- GATE: tsc; its 4 test files on `aggretrack_test_2`. Run stock-invariant twice.

### P2-C Selling backend
- OWNS: `src/lib/validation/selling.ts`, `src/lib/services/customers.ts`, `salesOrders.ts`, `allocation.ts`, `dispatches.ts`, `invoices.ts`, `customerPayments.ts`, `receivables.ts`, `src/actions/customers.ts`, `sales.ts`, `dispatches.ts`, `invoices.ts`, `customer-payments.ts`, `tests/integration/sales-allocation.test.ts`, `dispatch.test.ts`, `invoices.test.ts`, `customer-payments.test.ts`
- Scope: customers CRUD; sales orders + lines; allocation auto (domain fifo over available lots, oldest `received_date` first) or manual, writes lot_allocations status `reserved` (reservations reduce availability — enforced by stockCore); dispatch converts reservations → `dispatch` movements + waybill number + PDF job, delivered-weight entry → transit loss recorded; invoice from dispatch (optional tax line, off by default) + INV number + PDF; customer payments + allocation to invoices; receivables ageing. Include an oversell-under-concurrency test at the action/service level (two parallel allocations fighting for one lot).
- GATE: tsc; its 4 test files on `aggretrack_test_3`. Run the concurrency test twice.

### P2-D Logistics, costing, dashboard, reports backend
- OWNS: `src/lib/validation/logistics.ts`, `src/lib/services/trips.ts`, `expenses.ts`, `landedCost.ts` (service — applies domain sharing, updates lots.landed_cost_per_kg inside tx), `margin.ts` (service), `traceability.ts`, `reports.ts`, `dashboard.ts`, `src/actions/trips.ts`, `expenses.ts`, `reports.ts`, `tests/integration/landed-cost.test.ts`, `margin.test.ts`, `reports.test.ts`
- Scope: trips (inbound linked to purchases, outbound to dispatches) + costs; inbound trip cost + handling expenses shared across the trip's lots by weight (domain landedCost, largest-remainder) → recompute lot landed cost; expenses by category attachable to lot/trip/warehouse; traceability (lot → movements → customers; sale → lots → suppliers); margin per lot/sale/customer/commodity; all 10 report queries with date/filter params returning typed rows; dashboard aggregates.
- GATE: tsc; its 3 test files on `aggretrack_test_4`.

## Wave 3 — 4 frontend agents (UI over wave-2 actions; tsc-only gates)

### P3-A Buying UI
- OWNS: `src/app/(app)/suppliers/**`, `purchases/**`, `advances/**`, `supplier-payments/**`, `payables/**`, `price-guides/**`, `src/components/buying/**`
- Scope per SPEC Buying module. Purchase quick-entry: one-handed phone flow, supplier picker with inline-create, line editor showing live net kg + amount, over-guide warning badge, approval state. Supplier page: tabs profile/purchases/deductions/advances/payments + balance header + "Statement" button (wired in wave 4). GATE: tsc.

### P3-B Warehouse UI
- OWNS: `src/app/(app)/stock/**`, `movements/**`, `transfers/**`, `counts/**`, `adjustments/**`, `src/components/warehouse/**`
- Scope per SPEC Warehouse module: position drill-down (commodity→grade→warehouse→lot/bin, kg+bags+value), ageing bands view, transfer dispatch/receive-with-loss flow, count entry with variance highlight + post-adjustments, approval queue, movement history filters. GATE: tsc.

### P3-C Selling UI
- OWNS: `src/app/(app)/customers/**`, `sales/**`, `dispatches/**`, `invoices/**`, `customer-payments/**`, `receivables/**`, `src/components/selling/**`
- Scope per SPEC Selling module: order builder, allocation screen (auto-FIFO button + manual lot picker showing available per lot), dispatch + delivered-weight entry, invoice view/PDF link, payment record+allocate, receivables ageing, customer page + statement button. GATE: tsc.

### P3-D Dashboard + logistics + alerts + audit UI
- OWNS: `src/app/(app)/page.tsx` + `dashboard-components` in `src/components/logistics/**` and `src/components/shared/dashboard/**`, `src/app/(app)/trips/**`, `expenses/**`, `alerts/**`, `src/app/(app)/settings/audit/**`
- Scope: dashboard cards (stock value, buys/sales week+month, payables, receivables, gross margin) + Recharts trends + top suppliers/customers + alert feed; trips CRUD + linking UI; expenses; alerts centre; audit browser with before/after diff. GATE: tsc.

## Wave 4 — 4 agents (cross-cutting)

### P4-A Reports + exports
- OWNS: `src/app/(app)/reports/**`, `src/components/reports/**`, `src/lib/export/excel.ts`, `src/lib/export/reportPdf.tsx`, `src/app/api/exports/[report]/route.ts`, `tests/unit/excel.test.ts`
- Scope: reports index + [report] page with date/filter controls over P2-D queries; ExcelJS workbook per report; printable PDF per report; export route streams file with authz (`report.export`). GATE: tsc; excel unit test.

### P4-B Offline PWA + sync
- OWNS: `src/offline/**`, `src/app/sw.ts`, `public/manifest.webmanifest`, `src/app/api/sync/route.ts`, `src/lib/services/sync.ts`, `tests/integration/sync-idempotent.test.ts`; GRANTED: `src/app/(app)/purchases/new/**` (P3-A), purchase-receive + dispatch form components it must wire (list exact files in report).
- Scope: Dexie outbox + refData cache; offline detection + queue submit + "Queued/Synced/Failed" UI; sync client with backoff; `/api/sync` validating with the SAME zod schemas and calling the SAME services, idempotent on `(org_id, client_id)`; replay-twice test = DoD "same offline purchase twice creates one purchase". GATE: tsc; sync test on `aggretrack_test_1`.

### P4-C Billing + read-only + CSV import
- OWNS: `src/lib/services/billing.ts`, `imports.ts`, `src/lib/validation/billing.ts`, `imports.ts`, `src/actions/billing.ts`, `imports.ts`, `src/app/(app)/settings/billing/**`, `settings/import/**`, `src/app/api/webhooks/paystack/route.ts`, `tests/integration/billing.test.ts`, `imports.test.ts`; GRANTED: `src/adapters/payments/paystack.ts`, `worker/jobs/billing.ts`.
- Scope: plans/trial state page, Paystack hosted checkout via adapter, webhook (verify HMAC-SHA512 signature, update subscription status, idempotent on event id), trial-expiry sweep job; read-only enforcement test (expired trial org → mutation via guard returns error, read succeeds); CSV import (suppliers, customers, opening stock) with preview + row-level errors; opening stock = purchases marked `is_opening` + receive flow so lots/movements stay consistent. GATE: tsc; its 2 test files on `aggretrack_test_2`.

### P4-D Notifications + SMS receipts + statements
- OWNS: `src/lib/services/notifications.ts`, `statements.ts`, `src/actions/statements.ts`, `notifications.ts`, `src/components/notifications/**`, `tests/integration/alerts.test.ts`; GRANTED: `worker/jobs/alerts.ts`, `worker/jobs/sms.ts`, supplier/customer page statement-button files (list in report).
- Scope: notifications table service + bell/unread UI + alerts page data; real alert scans (low stock per commodity threshold, lots > 90 days, warehouse > 90% capacity) → notifications; SMS receipt enqueue on receive + on supplier payment (respecting org toggle); supplier/customer statement assembly (txns + running balance) → P1-D templates → document + download. GATE: tsc; alerts test on `aggretrack_test_3`.

## Wave 5 — integration (2 agents + orchestrator)

### P5-A Seed
- OWNS: `scripts/seed.ts`, `scripts/seed-data/**`
- Scope: platform admin + demo org (trialing, generous trial), one login per role (phones +23480000000{1..7}, password demo too), master data (7 commodities, grades, bag types, 2 warehouses + bins, 3 buying points, vehicles, drivers, expense categories), price guides, 40 suppliers, 8 customers, THREE MONTHS of coherent history (≈120 purchases → receipts → some transfers/counts/adjustments → ≈60 sales → dispatches → invoices → payments both sides → 20 trips + expenses with landed cost) built BY CALLING THE SERVICES (never raw inserts) with dates spread over the window so ageing bands and dashboard populate. Deterministic (seeded RNG). Idempotent guard: refuses to run twice on a non-empty org.
- GATE: tsc; `pnpm seed` completes on fresh `aggretrack_dev` (coordinate with orchestrator for the run).

### P5-B Playwright e2e
- OWNS: `e2e/**`
- Scope: (1) DoD flow: login → record purchase → receive (stock rises on stock page) → create sale → allocate → dispatch → invoice → record payment → margin report shows sale → lot trace shows supplier. (2) Auth + roles: warehouse keeper sees no prices with switch on; procurement restricted to own buying point. (3) Offline: with context offline, queue a purchase; back online → synced, appears once. Specs written against seeded `aggretrack_e2e`; orchestrator runs them.
- GATE: tsc only (orchestrator executes Playwright).

### Orchestrator close-out
README.md (verbatim Assumptions section + setup, stack-change notes, scripts table), docker compose build + up smoke, then the FULL gate serially: `tsc`, `eslint`, all unit, all integration (one DB, serial), seed on fresh dev DB, Playwright, `pnpm build`. Re-run every agent-claimed gate; trust nothing not re-run.
