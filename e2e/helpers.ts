import { expect, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";

/**
 * Shared helpers for the AggreTrack e2e specs. Every selector here is grounded
 * in the real components (ids / labels / button text quoted in comments).
 * Seed contract (P5-A): password demo1234 for every role, emails
 * <role>@demo.aggretrack.local, phones 2348000000001..6, org "Gombe AgriTrade".
 */

export type Role = "owner" | "manager" | "procurement" | "warehouse" | "sales" | "accountant";

export const ROLES: readonly Role[] = ["owner", "manager", "procurement", "warehouse", "sales", "accountant"];

export const PASSWORD = "demo1234";
export const ORG_NAME = "Gombe AgriTrade";
export const MAIN_WAREHOUSE = "Gombe Main";
export const COMMODITY = "Maize";
export const GRADE = "Grade A";

export const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:4137";
export const MOBILE_VIEWPORT = { width: 360, height: 740 };

/** Long-ish default for the slow dev box (Turbopack compiles routes on first hit). */
export const T = 15_000;
/** First visit to a route can compile for a long time under `next dev`. */
export const NAV_T = 90_000;

export function emailFor(role: Role): string {
  return `${role}@demo.aggretrack.local`;
}

export function phoneFor(role: Role): string {
  return `234800000000${ROLES.indexOf(role) + 1}`;
}

/** Unique suffix for names created during a run. */
export function uniqueRef(prefix = "E2E"): string {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}`;
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Today's calendar date in Africa/Lagos, "yyyy-mm-dd" (matches lagosTodayISO in the app). */
export function lagosToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Lagos",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// ── Money / weight parsing (formats from lib/domain/units formatNaira + displayKg) ──

/** "₦12,345.67" / "-₦1.00" → kobo. Returns null when no naira amount is found. */
export function parseNairaToKobo(text: string): number | null {
  const m = /(-)?₦\s?([\d,]+)(?:\.(\d{1,2}))?/.exec(text);
  if (!m) return null;
  const whole = Number.parseInt(m[2].replace(/,/g, ""), 10);
  const frac = Number.parseInt((m[3] ?? "").padEnd(2, "0") || "0", 10);
  const kobo = whole * 100 + frac;
  return m[1] ? -kobo : kobo;
}

/** Kobo → what a user types into a naira input ("10000000" / "350.50"). */
export function koboToNairaInput(kobo: number): string {
  const whole = Math.trunc(kobo / 100);
  const frac = kobo % 100;
  return frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(2, "0")}`;
}

/** "1,234.5 kg" → 1234.5. Returns null when no kg figure is found. */
export function parseKg(text: string): number | null {
  const m = /(-)?([\d,]+(?:\.\d+)?)\s?kg/.exec(text);
  if (!m) return null;
  const v = Number.parseFloat(m[2].replace(/,/g, ""));
  return m[1] ? -v : v;
}

/** Regex matching a rendered naira amount like "₦10,000.00". */
export const NAIRA_RE = /₦[\d,]+\.\d{2}/;
/** Regex matching a rendered weight like "9,950 kg" / "12.5 kg". */
export const KG_RE = /[\d,]+(?:\.\d+)? kg/;

export async function expectMoneyText(locator: Locator, kobo: number): Promise<void> {
  await expect(async () => {
    const text = (await locator.innerText()).trim();
    expect(parseNairaToKobo(text)).toBe(kobo);
  }).toPass({ timeout: T });
}

export async function expectKgText(locator: Locator, kg: number): Promise<void> {
  await expect(async () => {
    const text = (await locator.innerText()).trim();
    expect(parseKg(text)).toBeCloseTo(kg, 3);
  }).toPass({ timeout: T });
}

// ── Contexts + login ──────────────────────────────────────────────────────────

/** A fresh, isolated mobile context (its own cookies + IndexedDB outbox). */
export async function newMobileContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({ baseURL: BASE_URL, viewport: MOBILE_VIEWPORT });
}

/** Wait until the app shell (dashboard) is showing at "/". */
export async function expectOnDashboard(page: Page): Promise<void> {
  await page.waitForURL((u) => u.pathname === "/", { timeout: NAV_T });
  // AppShell top bar: <Button aria-label="Open menu">.
  await expect(page.getByRole("button", { name: "Open menu" })).toBeVisible({ timeout: NAV_T });
}

/**
 * Email + password login via the "Email" tab of /login (LoginTabs →
 * EmailLoginForm: #email, #password, "Sign in"). Retries when Better Auth's
 * rate limiter answers 429 ("Too many attempts…").
 */
export async function loginAs(page: Page, role: Role): Promise<void> {
  for (let attempt = 1; attempt <= 4; attempt++) {
    await page.goto("/login", { timeout: NAV_T });
    if (new URL(page.url()).pathname === "/") return expectOnDashboard(page); // already signed in
    await page.getByRole("tab", { name: "Email" }).click();
    await page.locator("#email").fill(emailFor(role));
    await page.locator("#password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();

    const outcome = await Promise.race([
      page
        .waitForURL((u) => u.pathname === "/", { timeout: NAV_T })
        .then(() => "ok" as const),
      page
        .getByText(/Too many attempts/)
        .first()
        .waitFor({ state: "visible", timeout: NAV_T })
        .then(() => "limited" as const),
      page
        .getByText("Email or password is incorrect.")
        .first()
        .waitFor({ state: "visible", timeout: NAV_T })
        .then(() => "bad" as const),
    ]).catch(() => "timeout" as const);

    if (outcome === "ok") return expectOnDashboard(page);
    if (outcome === "bad") throw new Error(`Seed login for ${role} (${emailFor(role)}) was rejected — is aggretrack_e2e seeded?`);
    // Rate limited or slow: back off past Better Auth's sign-in window and retry.
    await page.waitForTimeout(11_000);
  }
  throw new Error(`Could not sign in as ${role} after retries`);
}

/** New mobile context + page, signed in as `role`. */
export async function rolePage(browser: Browser, role: Role): Promise<{ context: BrowserContext; page: Page }> {
  const context = await newMobileContext(browser);
  const page = await context.newPage();
  await loginAs(page, role);
  return { context, page };
}

// ── Radix Select / navigation helpers ─────────────────────────────────────────

/** Open a Radix Select by its trigger and pick the option with this exact name. */
export async function chooseOption(page: Page, trigger: Locator, name: string | RegExp): Promise<void> {
  await trigger.click();
  await page.getByRole("option", { name, exact: typeof name === "string" }).click();
  await expect(page.getByRole("listbox")).toBeHidden({ timeout: T });
}

/** List the enabled option names of a Radix Select, then close it with Escape. */
export async function listOptions(page: Page, trigger: Locator): Promise<string[]> {
  await trigger.click();
  const listbox = page.getByRole("listbox");
  await expect(listbox).toBeVisible({ timeout: T });
  const names: string[] = [];
  const options = listbox.getByRole("option");
  const n = await options.count();
  for (let i = 0; i < n; i++) {
    const o = options.nth(i);
    if ((await o.getAttribute("aria-disabled")) === "true" || (await o.getAttribute("data-disabled")) !== null) continue;
    names.push((await o.innerText()).trim());
  }
  await page.keyboard.press("Escape");
  await expect(listbox).toBeHidden({ timeout: T });
  return names;
}

/** Pick the first enabled option whose text does NOT match `skip`; returns its text. */
export async function chooseFirstOption(page: Page, trigger: Locator, skip?: RegExp): Promise<string> {
  const names = (await listOptions(page, trigger)).filter((n) => !skip || !skip.test(n));
  if (names.length === 0) throw new Error("No selectable option found");
  await chooseOption(page, trigger, names[0]);
  return names[0];
}

/** Open the AppShell "More" sheet and return the nav link labels it lists. */
export async function navLabels(page: Page): Promise<string[]> {
  await page.getByRole("button", { name: "Open menu" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible({ timeout: T });
  const labels = (await sheet.getByRole("link").allInnerTexts()).map((s) => s.trim());
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden({ timeout: T });
  return labels;
}

/** A page-header status chip (components/ui/badge renders data-slot="badge"). */
export function badge(page: Page | Locator, label: string): Locator {
  return page.locator('[data-slot="badge"]', { hasText: new RegExp(`^\\s*${escapeRegExp(label)}\\s*$`) }).first();
}

/** Value <p> of a selling/page-states Stat (label <p> + value <p> siblings). */
export function statValue(scope: Page | Locator, label: string): Locator {
  return scope.getByText(label, { exact: true }).first().locator("xpath=following-sibling::*[1]");
}

/**
 * Purchase form price that stays within the day's price guide. Reads the
 * GuideHint under the line ("Guide max ₦350.00/kg" or "No price guide set…").
 */
export async function priceWithinGuide(page: Page, fallbackNaira = 300): Promise<string> {
  const hint = page.getByText(/Guide max ₦|No price guide set for this produce/).first();
  await expect(hint).toBeVisible({ timeout: 30_000 });
  const text = await hint.innerText();
  const maxKobo = parseNairaToKobo(text);
  if (maxKobo === null) return String(fallbackNaira);
  const naira = Math.max(1, Math.floor((maxKobo * 0.9) / 100));
  return String(naira);
}

/** Commodity <summary> on /stock (StockPositionView: "<name> … kg · bags · ₦"). */
export function commoditySummary(page: Page, commodity: string): Locator {
  return detailsSummary(page, commodity);
}

/**
 * A <summary> whose text starts with `name` (textContent runs the name into
 * the totals, e.g. "Maize9,950 kg", so no \b — just "not followed by a letter").
 */
export function detailsSummary(scope: Page | Locator, name: string): Locator {
  return scope
    .locator("details > summary")
    .filter({ hasText: new RegExp(`^\\s*${escapeRegExp(name)}(?![A-Za-z])`) })
    .first();
}

/** On-hand kg for a commodity on /stock (0 when it is not listed). */
export async function stockKgFor(page: Page, commodity: string): Promise<number> {
  await page.goto("/stock", { timeout: NAV_T });
  await expect(page.getByRole("heading", { name: "Stock", level: 1 })).toBeVisible({ timeout: NAV_T });
  const summary = commoditySummary(page, commodity);
  if ((await summary.count()) === 0) return 0;
  return parseKg(await summary.innerText()) ?? 0;
}
