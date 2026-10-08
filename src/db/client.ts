import type { ExtractTablesWithRelations } from 'drizzle-orm';
import {
  drizzle,
  type NodePgQueryResultHKT,
} from 'drizzle-orm/node-postgres';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import { Pool } from 'pg';
import * as schema from './schema';

export const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    'postgres://postgres:postgres@localhost:5432/aggretrack_dev',
});

export const db = drizzle({ client: pool, schema });

export type Db = typeof db;
export type Tx = PgTransaction<
  NodePgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;
export type DbOrTx = Db | Tx;
