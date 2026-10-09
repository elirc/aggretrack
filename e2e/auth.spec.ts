import { expect, test } from "@playwright/test";

import { NAV_T, ORG_NAME, T, expectOnDashboard, loginAs, phoneFor } from "./helpers";

/**
 * Auth: phone OTP (mock SMS driver → fixed code 123456), email + password,
 * and a wrong OTP. Note Better Auth limits /phone-number/send-otp to 3 per
 * 10 minutes; this file sends two codes per run.
 */

test.describe("auth", () => {
  test.setTimeout(180_000);

  test("phone OTP login lands on the dashboard (mock mode)", async ({ page }) => {
    await page.goto("/login", { timeout: NAV_T });
    // LoginTabs defaults to the "Phone" tab → PhoneLoginForm (#phone, "Send code").
    await expect(page.getByRole("tab", { name: "Phone" })).toHaveAttribute("aria-selected", "true");
    await page.locator("#phone").fill(phoneFor("owner"));
    await page.getByRole("button", { name: "Send code" }).click();

    await page.waitForURL(/\/verify\?phone=/, { timeout: NAV_T });
    // OtpForm shows the mock hint outside production with SMS_DRIVER=mock.
    await expect(page.getByText("Dev/mock code:")).toBeVisible({ timeout: T });
    await expect(page.getByText(`Sent to +${phoneFor("owner")}`)).toBeVisible({ timeout: T });
    await page.locator("#code").fill("123456");
    await page.getByRole("button", { name: "Verify" }).click();

    await expectOnDashboard(page);
    await expect(page.getByRole("link", { name: ORG_NAME }).first()).toBeVisible({ timeout: T });
  });

  test("email + password login as manager", async ({ page }) => {
    await loginAs(page, "manager");
    await expect(page.getByRole("link", { name: ORG_NAME }).first()).toBeVisible({ timeout: T });
    // The menu sheet header shows "<name> · <role>".
    await page.getByRole("button", { name: "Open menu" }).click();
    await expect(page.getByRole("dialog").getByText(/· manager$/)).toBeVisible({ timeout: T });
  });

  test("a wrong OTP shows an error and stays on /verify", async ({ page }) => {
    await page.goto("/login", { timeout: NAV_T });
    await page.locator("#phone").fill(phoneFor("manager"));
    await page.getByRole("button", { name: "Send code" }).click();
    await page.waitForURL(/\/verify\?phone=/, { timeout: NAV_T });

    await page.locator("#code").fill("000000");
    await page.getByRole("button", { name: "Verify" }).click();

    // authErrorMessage: INVALID_OTP → "That code is not correct." (falls back to the server message).
    await expect(page.getByText(/That code is not correct\.|invalid|incorrect/i).first()).toBeVisible({ timeout: T });
    await expect(page.locator("#code")).toHaveAttribute("aria-invalid", "true");
    expect(new URL(page.url()).pathname).toBe("/verify");
  });
});
