/**
 * Load .env BEFORE any module that reads process.env at import time
 * (src/db/client.ts builds its pool from DATABASE_URL on import).
 * scripts/seed.ts imports this file first.
 */
import { config } from "dotenv";

config({ quiet: true });
