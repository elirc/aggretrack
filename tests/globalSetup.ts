// Vitest globalSetup for integration tests: create the test database if
// missing and bring its schema up to date before any suite runs.
import { setupTestDb } from "../src/lib/test/setup";

export default async function globalSetup() {
  await setupTestDb();
}
