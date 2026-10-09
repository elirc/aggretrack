import { sql } from "drizzle-orm";
import { db } from "@/db/client";

export async function GET() {
  let dbOk = false;
  try {
    await db.execute(sql`select 1`);
    dbOk = true;
  } catch {
    dbOk = false;
  }
  return Response.json({ ok: dbOk, db: dbOk, version: "1.0.0" });
}
