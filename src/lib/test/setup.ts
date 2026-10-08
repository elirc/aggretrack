import path from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import { Client, Pool } from "pg";

import * as schema from "@/db/schema";

/**
 * Integration-test harness (ARCHITECTURE §Testing).
 *
 * DB name comes from TEST_DB_NAME (default aggretrack_test); each parallel
 * implementer agent uses its own database (aggretrack_test_1..4) — never share.
 * Suites that share a database must not interleave: vitest fileParallelism=false.
 */

const PG_HOST = process.env.TEST_PG_HOST ?? "localhost";
const PG_PORT = Number(process.env.TEST_PG_PORT ?? 5432);
const PG_USER = process.env.TEST_PG_USER ?? "postgres";
const PG_PASSWORD = process.env.TEST_PG_PASSWORD ?? "postgres";

export function testDbName(): string {
  return process.env.TEST_DB_NAME ?? "aggretrack_test";
}

export function testDbUrl(dbName = testDbName()): string {
  return `postgres://${PG_USER}:${PG_PASSWORD}@${PG_HOST}:${PG_PORT}/${dbName}`;
}

/** Create the test database if missing and bring it to the current migration state. */
export async function setupTestDb(): Promise<void> {
  const admin = new Client({ connectionString: testDbUrl("postgres") });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${testDbName()}"`);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== "42P04") throw err; // 42P04 = duplicate_database
  } finally {
    await admin.end();
  }

  const pool = new Pool({ connectionString: testDbUrl(), max: 1 });
  try {
    const db = drizzle({ client: pool, schema });
    await migrate(db, {
      migrationsFolder: path.resolve(process.cwd(), "drizzle"),
    });
  } finally {
    await pool.end();
  }
}

/** Every business + auth table, in one TRUNCATE (order-safe via CASCADE). */
const ALL_TABLES = [
  // auth
  "user",
  "session",
  "account",
  "verification",
  "organization",
  "member",
  "invitation",
  // org extensions
  "organisation_settings",
  "member_warehouse_access",
  "member_buying_point_access",
  // master data
  "commodities",
  "grades",
  "bag_types",
  "buying_points",
  "warehouses",
  "bins",
  "vehicles",
  "drivers",
  "expense_categories",
  "price_guides",
  // suppliers
  "suppliers",
  "supplier_advances",
  "supplier_payments",
  "supplier_payment_allocations",
  "supplier_advance_offsets",
  // purchases
  "purchases",
  "purchase_lines",
  "purchase_line_deductions",
  // stock
  "lots",
  "stock_movements",
  "transfers",
  "transfer_lines",
  "stock_counts",
  "stock_count_lines",
  "adjustments",
  // sales
  "customers",
  "sales_orders",
  "sales_lines",
  "lot_allocations",
  "dispatches",
  "dispatch_lines",
  "invoices",
  "customer_payments",
  "customer_payment_allocations",
  // logistics
  "trips",
  "trip_purchases",
  "trip_dispatches",
  "expenses",
  // billing
  "plans",
  "subscriptions",
  // system
  "document_counters",
  "documents",
  "notifications",
  "audit_log",
];

export type TestDb = ReturnType<typeof drizzle<typeof schema>>;

/** Truncate every table between test files. Leaves drizzle's migrations table alone. */
export async function truncateAll(db: TestDb): Promise<void> {
  const list = ALL_TABLES.map((t) => `"${t}"`).join(", ");
  await db.execute(sql.raw(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`));
}

/** A pooled drizzle handle on the test database. Close it in afterAll. */
export function makeTestDb(): { db: TestDb; pool: Pool; close: () => Promise<void> } {
  const pool = new Pool({ connectionString: testDbUrl(), max: 5 });
  const db = drizzle({ client: pool, schema });
  return { db, pool, close: () => pool.end() };
}
