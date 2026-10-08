import { PgBoss, type SendOptions } from "pg-boss";
// Relative import on purpose: worker runs under tsx, where the `@/*` alias is
// not guaranteed. Wave-1 worker/jobs/* files should also import src via relative paths.
import { ALL_QUEUES } from "../src/lib/jobs";

let bossPromise: Promise<PgBoss> | null = null;

/** Started, queues-ensured pg-boss singleton. Shared by worker and web (send-only). */
export function getBoss(): Promise<PgBoss> {
  if (!bossPromise) {
    bossPromise = (async () => {
      const url = process.env.DATABASE_URL;
      if (!url) {
        throw new Error("DATABASE_URL is required for pg-boss");
      }
      const boss = new PgBoss(url);
      boss.on("error", (err: unknown) => console.error("[pg-boss]", err));
      await boss.start();
      // createQueue is idempotent in pg-boss 12; sends to a non-existent queue fail.
      for (const queue of ALL_QUEUES) {
        await boss.createQueue(queue);
      }
      return boss;
    })();
    bossPromise.catch(() => {
      bossPromise = null; // allow retry after a failed boot
    });
  }
  return bossPromise;
}

/** Enqueue helper for the web process. */
export async function enqueue(
  name: string,
  data: object,
  options?: SendOptions,
): Promise<string | null> {
  const boss = await getBoss();
  return options ? boss.send(name, data, options) : boss.send(name, data);
}
