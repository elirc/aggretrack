import { expect, test, type Browser } from "@playwright/test";

import { NAV_T, T, listOptions, navLabels, rolePage } from "./helpers";

/**
 * Roles + restrictions:
 * - warehouse keeper with the org-wide "Hide prices from warehouse keepers"
 *   switch ON (owner flips it in /settings first; restored afterwards);
 * - procurement officer restricted to their buying point(s).
 */

/** Owner flips OrgSettingsForm's #hidePricesFromWarehouse switch and saves. */
async function setHidePrices(browser: Browser, on: boolean): Promise<void> {
  const { context, page } = await rolePage(browser, "owner");
  try {
    await page.goto("/settings", { timeout: NAV_T });
    const sw = page.getByRole("switch", { name: "Hide prices from warehouse keepers" });
    await expect(sw).toBeVisible({ timeout: NAV_T });
    const checked = (await sw.getAttribute("aria-checked")) === "true";
    if (checked === on) return;
    await sw.click();
    await expect(sw).toHaveAttribute("aria-checked", String(on));
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(page.getByText("Settings saved").first()).toBeVisible({ timeout: T });
  } finally {
    await context.close();
  }
}

const NO_POINT = /^(No buying point|Pick your buying point)$/;

test.describe.serial("roles and restrictions", () => {
  test.setTimeout(180_000);

  test.afterAll(async ({ browser }) => {
    // Leave the seeded default (switch OFF) for any later run.
    await setHidePrices(browser, false);
  });

  test("warehouse keeper sees no prices when the switch is on", async ({ browser }) => {
    await setHidePrices(browser, true);

    const { context, page } = await rolePage(browser, "warehouse");
    try {
      await page.goto("/stock", { timeout: NAV_T });
      await expect(page.getByRole("heading", { name: "Stock", level: 1 })).toBeVisible({ timeout: NAV_T });
      const main = page.locator("main");
      // StockPositionView renders "On hand" totals; value fields are absent with hidePrices.
      await expect(main.getByText("On hand").first()).toBeVisible({ timeout: T });
      await expect(main.getByText("Value (landed)")).toHaveCount(0);
      // textContent (not innerText) also covers collapsed <details> lot rows.
      expect(await main.textContent()).not.toContain("₦");

      // Nav: no selling or payables entries for the keeper (permission-filtered AppShell).
      const labels = await navLabels(page);
      expect(labels).toContain("Stock");
      for (const hidden of ["Sales", "Payables", "Customers", "Invoices", "Customer payments", "Receivables"]) {
        expect(labels, `nav should not list ${hidden}`).not.toContain(hidden);
      }
      // Bottom bar has no "Sell" slot either.
      await expect(page.getByRole("navigation").getByRole("link", { name: "Sell" })).toHaveCount(0);

      // The keeper can still open the dispatches list (dispatch.read → delivery).
      await page.goto("/dispatches", { timeout: NAV_T });
      await expect(page.getByRole("heading", { name: "Dispatches", level: 1 })).toBeVisible({ timeout: NAV_T });
      await expect(page.getByText(/You don.t have access/)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("procurement only sees their allowed buying points and no selling pages", async ({ browser }) => {
    // Unrestricted reference list from the owner.
    const owner = await rolePage(browser, "owner");
    let allPoints: string[];
    try {
      await owner.page.goto("/purchases/new", { timeout: NAV_T });
      const trigger = owner.page.locator("#p-point");
      await expect(trigger).toBeVisible({ timeout: NAV_T });
      allPoints = (await listOptions(owner.page, trigger)).filter((n) => !NO_POINT.test(n));
    } finally {
      await owner.context.close();
    }
    expect(allPoints.length).toBeGreaterThan(1);

    const { context, page } = await rolePage(browser, "procurement");
    try {
      await page.goto("/purchases/new", { timeout: NAV_T });
      const trigger = page.locator("#p-point");
      await expect(trigger).toBeVisible({ timeout: NAV_T });
      const options = await listOptions(page, trigger);
      // Restricted officers must pick a point: no "No buying point" choice.
      expect(options).not.toContain("No buying point");
      const mine = options.filter((n) => !NO_POINT.test(n));
      expect(mine.length).toBeGreaterThan(0);
      expect(mine.length).toBeLessThan(allPoints.length);
      for (const p of mine) expect(allPoints).toContain(p);

      const labels = await navLabels(page);
      expect(labels).toContain("Purchases");
      for (const hidden of ["Sales", "Customers", "Invoices", "Customer payments", "Receivables"]) {
        expect(labels, `nav should not list ${hidden}`).not.toContain(hidden);
      }
      await expect(page.getByRole("navigation").getByRole("link", { name: "Sell" })).toHaveCount(0);

      // Direct navigation is refused too (selling NoAccess).
      await page.goto("/sales", { timeout: NAV_T });
      await expect(page.getByText(/You don.t have access/).first()).toBeVisible({ timeout: NAV_T });
    } finally {
      await context.close();
    }
  });
});
