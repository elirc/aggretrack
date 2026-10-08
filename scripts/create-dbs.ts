/**
 * Create all AggreTrack databases on the local Postgres and migrate the dev DB.
 * Run: pnpm create-dbs   (tsx scripts/create-dbs.ts)
 */
import path from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client, Pool } from "pg";

const HOST = process.env.PG_HOST ?? "localhost";
const PORT = Number(process.env.PG_PORT ?? 5432);
const USER = process.env.PG_USER ?? "postgres";
const PASSWORD = process.env.PG_PASSWORD ?? "postgres";

const DATABASES = [
  "aggretrack_dev",
  "aggretrack_test",
  "aggretrack_test_1",
  "aggretrack_test_2",
  "aggretrack_test_3",
  "aggretrack_test_4",
  "aggretrack_e2e",
];

function url(db: string): string {
  return `postgres://${USER}:${PASSWORD}@${HOST}:${PORT}/${db}`;
}

async function main(): Promise<void> {
  const admin = new Client({ connectionString: url("postgres") });
  await admin.connect();
  try {
    for (const name of DATABASES) {
      try {
        await admin.query(`CREATE DATABASE "${name}"`);
        console.log(`created   ${name}`);
      } catch (err) {
        if ((err as { code?: string }).code === "42P04") {
          console.log(`exists    ${name}`);
        } else {
          throw err;
        }
      }
    }
  } finally {
    await admin.end();
  }

  console.log("migrating aggretrack_dev ...");
  const pool = new Pool({ connectionString: url("aggretrack_dev"), max: 1 });
  try {
    await migrate(drizzle({ client: pool }), {
      migrationsFolder: path.resolve(process.cwd(), "drizzle"),
    });
    console.log("migrated  aggretrack_dev");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
