# Orchestrator decisions — canon where plan files disagree

These override DATA-MODEL.md / DOMAIN-ENGINE.md / ARCHITECTURE.md / TASKS.md where they conflict. Implementers follow THIS file first.

1. **Schema files** (src/db/schema/): `auth.ts, org.ts, master.ts, suppliers.ts, purchases.ts, stock.ts, sales.ts, logistics.ts, billing.ts, system.ts` (DATA-MODEL wins over ARCHITECTURE's buying/selling naming). Re-export all from `src/db/schema/index.ts`.
2. **Auth tables are hand-written**, not CLI-generated: `user, session, account, verification, organization, member, invitation` in `auth.ts` following Better Auth 1.7 documented shapes (text ids, camelCase TS / snake_case SQL), plus `user.phone_number`, `user.phone_number_verified`, `user.is_platform_admin`, `session.active_organization_id`. If the Better Auth CLI output differs at wiring time, the orchestrator reconciles.
3. **Member restrictions**: tables `member_warehouse_access` + `member_buying_point_access` (DATA-MODEL wins; no `member_settings`). The hide-prices switch is org-wide: `organisation_settings.hide_prices_from_warehouse`. `ctx.restrictions.hidePrices = (role === 'warehouse') && orgSettings.hide_prices_from_warehouse`.
4. **doc_type enum**: DATA-MODEL's list INCLUDING `exp`: po, grn, lot, trf, wb, so, inv, adj, cnt, adv, spm, cpm, trp, exp. `nextDocNumber(tx, orgId, type: DocType)` takes the lowercase enum value; prefix = uppercase.
5. **Domain file names** (src/lib/domain/): `units.ts, weights.ts, stock.ts, allocation.ts, costSharing.ts, payments.ts, ageing.ts, margin.ts, numbering.ts (formatDocNumber), format.ts` — DOMAIN-ENGINE's names + signatures win over TASKS P1-C's names. P1-C implements these exact files.
6. **Test layout**: `tests/unit/*.test.ts` (pure) and `tests/integration/*.test.ts` (DB) — ARCHITECTURE/TASKS win. DOMAIN-ENGINE's 11 required tests map: weights, allocation, costSharing, payments, ageing, margin → tests/unit/<name>.test.ts; stock-invariant, oversell, sync-idempotency, numbering, tenancy → tests/integration/<name>.test.ts.
7. **Versions**: Next 16 (Turbopack dev; production build uses `next build --webpack` because of Serwist — note in README), zod 4, @tanstack/react-table pinned v8, vitest latest, drizzle-orm 0.45.x, pg-boss 12, better-auth 1.7.
8. **OrgContext** (src/lib/authz/context.ts):
   ```ts
   type Role = 'owner'|'manager'|'procurement'|'warehouse'|'sales'|'accountant';
   type OrgContext = { orgId: string; userId: string; role: Role;
     restrictions: { warehouseIds: string[] | null; buyingPointIds: string[] | null; hidePrices: boolean };
     readOnly: boolean };
   ```
   Services take `(tx-or-db, ctx, input)`. `null` restriction = unrestricted.
9. **Weights in code are integer grams** (`Grams = number`), DB `numeric(12,3)` kg strings at the boundary via `kgToGrams`/`gramsToKg` in domain/units.ts. Money integer kobo (`bigint` column, drizzle `mode: 'number'`). `lots.landed_cost_per_kg_kobo` numeric(14,4) read as string, parsed with a dedicated helper.
10. **Better Auth roles**: do NOT use the access-control plugin's permission system for business permissions — organization plugin stores the role string on `member.role`; OUR permission matrix in `src/lib/authz/permissions.ts` is the single authority checked by the guard.
11. **Offline idempotency**: PK = client UUID on purchases/purchase_lines/dispatches (DATA-MODEL wins over ARCHITECTURE's `(org_id, client_id)` unique). Duplicate detection: select-by-id within org before insert.
12. **Numbering doc types from ARCHITECTURE** (`'GRN'|'WB'|...` uppercase) are WRONG — use lowercase doc_type enum values (decision 4).
13. **DB names**: dev `aggretrack_dev`, integration `aggretrack_test` (+ `aggretrack_test_1..4` per-agent), e2e `aggretrack_e2e`. Local PG: postgres/postgres@localhost:5432 (native, not Docker, for dev on this box).
14. **pnpm scripts** (package.json): `dev`, `build` (webpack), `start`, `lint`, `typecheck`, `test` (unit), `test:integration`, `test:e2e`, `worker:dev`, `worker`, `db:generate`, `db:migrate`, `db:push`, `seed`, `create-dbs`.
