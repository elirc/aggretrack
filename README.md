# AggreTrack

AggreTrack is the operations system for an agricultural aggregation business: one that buys produce from many farmers and agents, stores it, and sells it to buyers who cannot reach those farmers. It answers three questions at any moment: **who did I buy from and how much, what is in each warehouse, and who did I sell to at what margin.**

Multi-tenant SaaS. Next.js App Router + PostgreSQL. Mobile-first (360 px), installable PWA with an offline purchase/receipt/dispatch queue.

## Assumptions

- This is an internal operations tool sold as multi-tenant software. The owner's business is the first organisation; other aggregators can subscribe later.
- Each organisation sets up its own commodities and grades (for example maize, soybean, rice paddy, sorghum, sesame, ginger, cashew).
- Produce is bought by the bag and by weight. A purchase line records bags, gross weight, deductions (moisture, foreign matter, sack weight) and net weight.
- Every purchase line creates a lot. Stock is tracked and costed per lot, so any sale can be traced back to the suppliers it came from.
- Sales take stock from the oldest lots first unless the user picks lots by hand.
- A lot's cost per kg is its purchase price plus its share of inbound transport and handling, shared by weight.
- Paying farmers in advance is common, so supplier advances and balances are tracked.
- Payments are recorded, not processed. Staff enter cash, transfer or POS payments by hand. There is no bank integration.
- This is not an accounting system. There is no general ledger, tax filing or payroll. Reports export to Excel for an accountant.
- Invoices have an optional tax line that is off by default.
- Logistics means trip records (vehicle, driver, route, cost) for inbound and outbound loads. There is no GPS tracking or route planning.
- Weights are typed in. There is no weighbridge or scale connection.
- Buying happens where the network is poor, so purchases and stock receipts can be entered offline on a phone and sync later.
- Market: Nigeria first. Single currency (Naira), Africa/Lagos time, metric units. Staff mostly use Android phones.
- A phone number is the main login, verified by a one-time code. The language is English.
- Web only: no native mobile apps in version one.
- Pricing is a placeholder: a monthly subscription per organisation with a 14-day free trial and a user limit per plan.

## Quick start

```bash
# Docker (db + web + worker, demo mode with mock adapters)
docker compose up -d
pnpm seed            # demo organisation + 3 months of data

# Local development (native PostgreSQL on localhost:5432)
pnpm install
cp .env.example .env         # adjust DATABASE_URL etc.
pnpm create-dbs              # creates dev/test/e2e databases + migrates dev
pnpm dev                     # web on http://localhost:3000
pnpm worker:dev              # pg-boss worker (separate terminal)
```

Mock mode: the login OTP is always **123456**, and no external call is made. The app refuses to start with `APP_ENV=production` while any adapter driver is `mock` (`APP_ENV=demo` is the Compose default and allows mocks).

Demo logins after `pnpm seed` (demo org **Gombe AgriTrade**, growth plan, 60-day trial — starter's 5-user cap can't hold six role logins). Password `demo1234` on the email tab; phone OTP is `123456` in mock mode:

| Role | Phone | Email |
|---|---|---|
| Owner | 2348000000001 | owner@demo.aggretrack.local |
| Manager | 2348000000002 | manager@demo.aggretrack.local |
| Procurement | 2348000000003 | procurement@demo.aggretrack.local |
| Warehouse keeper | 2348000000004 | warehouse@demo.aggretrack.local |
| Sales officer | 2348000000005 | sales@demo.aggretrack.local |
| Accountant | 2348000000006 | accountant@demo.aggretrack.local |
| Platform admin | 2348000000007 | platform@demo.aggretrack.local |

The warehouse keeper is restricted to the Gombe Main warehouse; procurement is restricted to the Kwadon and Billiri buying points. Re-seed any time with `pnpm exec tsx scripts/seed.ts --reset` (guarded: only `aggretrack_dev` / `aggretrack_e2e`).

## Scripts

| Script | What it does |
|---|---|
| `pnpm dev` | Next dev server (Turbopack) |
| `pnpm build` | Production build (`next build --webpack`, see stack notes) |
| `pnpm start` | Serve the production build |
| `pnpm worker` / `pnpm worker:dev` | pg-boss worker (tsx / watch mode) |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint` / `pnpm format` | ESLint / Prettier |
| `pnpm test` | Unit tests (pure domain, no DB) |
| `pnpm test:integration` | DB-backed service tests (`TEST_DB_NAME` selects the database) |
| `pnpm test:e2e` | Playwright against a seeded `aggretrack_e2e` database |
| `pnpm db:generate` / `db:migrate` / `db:push` | drizzle-kit migrations |
| `pnpm create-dbs` | Create all local databases and migrate the dev one |
| `pnpm seed` | Demo organisation with three months of coherent history |

## Stack notes (changes vs. the original spec)

The spec said "use the current stable version and note the change" — these are the notes:

- **Next.js 16.4** (App Router, `src/`). Scaffolding enables Cache Components by default; this app turned it off — an auth-scoped, fully dynamic ops tool gains nothing from it in v1.
- **Serwist 9** is webpack-oriented, so the production build runs `next build --webpack`. Dev uses Turbopack with the service worker disabled.
- **Better Auth 1.7.7**: the Drizzle adapter moved to its own package `@better-auth/drizzle-adapter`. The phoneNumber plugin has no `generateOTP` hook, so mock mode supplies a custom `verifyOTP` that accepts the fixed code 123456; real mode uses the plugin's internal verification.
- **@tanstack/react-table is pinned to v8** (v9 is out but the ecosystem docs and shadcn recipes still target v8).
- **zod 4**, **drizzle-orm 0.45** (v1 is still beta), **pg-boss 12** (queues must be created before use; `work` handlers receive job arrays).
- **shadcn/ui** no longer ships a `form` component; forms use react-hook-form + zodResolver with the `field` primitives.
- **PDFs print "NGN"** instead of ₦ — the built-in Helvetica font has no naira glyph, and shipping no custom font keeps PDF rendering fully offline.
- **@react-pdf/renderer is ESM-only**: the worker (tsx, CJS package) loads it through a dynamic-import shim in `src/pdf/runtime.ts`. New templates must follow the same pattern.
- **Docker caveat**: the Compose stack (db/web/worker) ships reviewed but was built on a machine without Docker; every gate (tests, build, e2e, seed) was run against the native local setup instead.

## Architecture in one paragraph

Server Components read, Server Actions mutate, route handlers serve webhooks/sync/documents. Every action passes through one guard (`orgAction`): session → server-resolved organisation → role permission → read-only check → zod validation. Money is integer kobo; weights are integer grams in code and `numeric(12,3)` kg in PostgreSQL. Stock changes only through append-only `stock_movements` written by a single service (`stockCore.postMovements`) that locks lots `FOR UPDATE` in id order and rejects anything that would drive stock negative — reservations included. Document numbers are gapless per organisation and year (`GRN-2026-00001`), allocated inside the owning transaction. Costing: a lot's landed cost = purchase price + its weight-share of inbound trip costs and handling expenses (largest-remainder sharing, so kobo always sum exactly); late costs re-cost the lot and flow into margin reports without touching issued invoices. The pg-boss worker renders PDFs, sends SMS/email through env-switched adapters (Termii/Resend/Paystack or mocks), scans for stock alerts, and sweeps billing. Offline entry queues records in IndexedDB with client-generated UUIDs; `/api/sync` replays them idempotently.

## Documentation

- `docs/SPEC.md` — the product specification this app was built against.
- `docs/plan/` — data model, domain algorithms, architecture, build-wave contract, integration reference, and the decision log where they disagree.
