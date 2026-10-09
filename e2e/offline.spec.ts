import { expect, test } from "@playwright/test";

import {
  COMMODITY,
  GRADE,
  NAV_T,
  T,
  chooseFirstOption,
  chooseOption,
  escapeRegExp,
  lagosToday,
  priceWithinGuide,
  rolePage,
} from "./helpers";

/**
 * Offline purchase: queue in the Dexie outbox while the context is offline,
 * come back online, sync through /api/sync, and the purchase exists once.
 * The client UUID is the purchase PK (DECISIONS #11), so a replay can't
 * double-insert.
 */

test.describe("offline purchase entry", () => {
  test.setTimeout(180_000);

  test("queued offline → synced online → appears exactly once", async ({ browser }) => {
    const { context, page } = await rolePage(browser, "procurement");
    try {
      await page.goto("/purchases/new", { timeout: NAV_T });
      await expect(page.getByRole("heading", { name: "New purchase", level: 1 })).toBeVisible({ timeout: NAV_T });
      await page.waitForLoadState("networkidle", { timeout: NAV_T }).catch(() => undefined);

      // While online, pick the produce so the price-guide lookup can resolve.
      const point = page.locator("#p-point");
      if (await point.isVisible()) {
        const current = (await point.innerText()).trim();
        if (!current || /No buying point|Pick your buying point/.test(current)) {
          await chooseFirstOption(page, point, /No buying point|Pick your buying point/);
        }
      }
      await chooseOption(page, page.locator("#l0-commodity"), COMMODITY);
      await chooseOption(page, page.locator("#l0-grade"), GRADE);
      const price = await priceWithinGuide(page);

      // ── Offline ──
      await context.setOffline(true);
      // OutboxIndicator (role=status) switches to its offline banner.
      await expect(page.getByText(/You are offline\./)).toBeVisible({ timeout: T });

      await page.locator("#p-supplier").click();
      const firstSupplier = page.getByRole("option").filter({ hasNotText: "Add new supplier" }).first();
      await expect(firstSupplier).toBeVisible({ timeout: T });
      await firstSupplier.click();
      await page.locator("#l0-bags").fill("10");
      await page.locator("#l0-gross").fill("1000");
      await page.locator("#l0-price").fill(price);
      await page.getByRole("button", { name: /^(Save purchase|Submit for approval)$/ }).click();

      // Queued state: QueuedBadge + "Saved on this phone…" + the outbox count.
      await expect(page.getByText("Queued — will sync", { exact: true })).toBeVisible({ timeout: T });
      await expect(page.getByText(/Saved on this phone/)).toBeVisible();
      await expect(page.getByText(/1 queued — will sync/)).toBeVisible();

      // ── Back online ── the sync loop flushes on the window "online" event.
      await context.setOffline(false);
      const synced = page.getByText(/Synced · /);
      try {
        await expect(synced).toBeVisible({ timeout: 20_000 });
      } catch {
        // Fallback: the explicit "Sync now" button in OutboxIndicator.
        const syncNow = page.getByRole("button", { name: "Sync now" });
        if (await syncNow.isVisible()) await syncNow.click();
        await expect(synced).toBeVisible({ timeout: NAV_T });
      }
      const syncedText = (await synced.innerText()).trim();
      const poNumber = syncedText.replace(/^.*Synced · /, "").trim();
      expect(poNumber).not.toBe("");

      // Open it → the server copy is marked as recorded offline.
      await page.getByRole("button", { name: "Open purchase" }).click();
      await page.waitForURL(/\/purchases\/[0-9a-f-]{36}$/, { timeout: NAV_T });
      await expect(page.getByRole("heading", { name: poNumber, level: 1 })).toBeVisible({ timeout: T });
      await expect(page.getByText("Recorded offline")).toBeVisible();

      // Purchases list for today: the PO number shows up exactly once.
      const today = lagosToday();
      await page.goto(`/purchases?from=${today}&to=${today}`, { timeout: NAV_T });
      await expect(page.getByRole("heading", { name: "Purchases", level: 1 })).toBeVisible({ timeout: NAV_T });
      await page.reload({ timeout: NAV_T });
      const rows = page
        .getByRole("link")
        // Mobile card textContent runs the supplier name into "PO-… · date", so guard digits only.
        .filter({ hasText: new RegExp(`(?<![0-9])${escapeRegExp(poNumber)}(?![0-9])`) })
        .filter({ visible: true });
      await expect(rows.first()).toBeVisible({ timeout: T });
      await expect(rows).toHaveCount(1);
    } finally {
      await context.setOffline(false).catch(() => undefined);
      await context.close();
    }
  });
});
