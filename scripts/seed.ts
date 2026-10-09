/**
 * AggreTrack demo seed — "Gombe AgriTrade" with one login per role and three
 * months of coherent history built by calling the services.
 *
 *   pnpm seed                         seed DATABASE_URL (refuses if the demo org exists)
 *   pnpm exec tsx scripts/seed.ts --reset
 *                                     drop + recreate + migrate DATABASE_URL first
 *                                     (only aggretrack_dev / aggretrack_e2e)
 *
 * Every login uses password demo1234 (mock OTP 123456 for phone login).
 * Deterministic: mulberry32(42). Exits non-zero if any verification fails.
 */
import "./seed-data/env"; // must stay first: loads .env before the db client reads DATABASE_URL

import { db, pool } from "../src/db/client";

import { DEMO_ORG, PLATFORM_ADMIN, ROLE_USERS } from "./seed-data/constants";
import { Calendar } from "./seed-data/dates";
import { seedHistory } from "./seed-data/history";
import { Rng } from "./seed-data/rng";
import {
  applyRestrictions,
  databaseName,
  demoOrgExists,
  migrateDatabase,
  resetDatabase,
  seedCustomers,
  seedIdentity,
  seedMasterData,
  seedSuppliers,
} from "./seed-data/setup";
import { verifySeed } from "./seed-data/verify";

async function main(): Promise<number> {
  const reset = process.argv.includes("--reset");
  const started = Date.now();
  console.log(`AggreTrack seed → database "${databaseName()}"${reset ? " (--reset)" : ""}`);

  if (reset) await resetDatabase();
  await migrateDatabase();

  if (await demoOrgExists(db)) {
    console.error(
      `Refusing to seed: organisation "${DEMO_ORG.slug}" already exists. Re-run with --reset (aggretrack_dev / aggretrack_e2e only).`,
    );
    return 1;
  }

  const rng = new Rng(42);
  const cal = new Calendar();
  console.log(`window    ${cal.start} → ${cal.today}`);

  const { ctxs, memberIds } = await seedIdentity(db);
  console.log("identity  platform admin, plans, org, 6 role logins");
  const master = await seedMasterData(db, ctxs, cal);
  await applyRestrictions(db, ctxs, memberIds, master);
  console.log("master    commodities, grades, bag types, warehouses, bins, buying points, fleet, categories, price guides");
  const suppliers = await seedSuppliers(db, ctxs.procurement, rng);
  const customers = await seedCustomers(db, ctxs.sales);
  console.log(`parties   ${suppliers.length} suppliers, ${customers.length} customers`);

  console.log("history   simulating 90 days …");
  const stats = await seedHistory(db, rng, cal, ctxs, master, suppliers, customers);
  console.log("\n── Simulation counters ──────────────────────────────────");
  for (const [k, v] of Object.entries(stats).sort()) console.log(`  ${k.padEnd(28)} ${v}`);

  const ok = await verifySeed(db, ctxs.owner, master, reset);

  console.log("\n── Logins (password demo1234, OTP 123456 in mock mode) ──");
  for (const u of ROLE_USERS) console.log(`  ${u.role.padEnd(12)} ${u.phone}  ${u.email}  ${u.name}`);
  console.log(`  ${"platform".padEnd(12)} ${PLATFORM_ADMIN.phone}  ${PLATFORM_ADMIN.email}  ${PLATFORM_ADMIN.name}`);
  console.log(`\n${ok ? "SEED OK" : "SEED FAILED VERIFICATION"} in ${Math.round((Date.now() - started) / 1000)}s`);
  return ok ? 0 : 1;
}

main()
  .then(async (code) => {
    await pool.end();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error(err);
    await pool.end().catch(() => undefined);
    process.exit(1);
  });
