import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

import {
  COMMODITY,
  GRADE,
  MAIN_WAREHOUSE,
  NAV_T,
  T,
  badge,
  chooseFirstOption,
  chooseOption,
  detailsSummary,
  escapeRegExp,
  koboToNairaInput,
  parseKg,
  parseNairaToKobo,
  priceWithinGuide,
  rolePage,
  statValue,
  stockKgFor,
  type Role,
} from "./helpers";

/**
 * SPEC "Definition of done" flow, end to end against the seeded aggretrack_e2e:
 * purchase → receive (stock rises) → sale → FIFO allocate → dispatch →
 * delivery (transit loss) → invoice → customer payment (paid) → margin report
 * → lot trace (supplier + customer).
 *
 * Role notes (src/lib/authz/permissions.ts): sales has no `dispatch.deliver`
 * and no `report.read`, so the manager records the delivery and the
 * accountant reads the margin report and traces.
 */

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

const BAGS = "100";
const GROSS_KG = "10000";
const MOISTURE_DEDUCTION_KG = "50";
const NET_KG = 9950;
const SALE_KG = "5000";
const SALE_PRICE_NAIRA = "2000"; // well above any plausible maize landed cost → margin > 0
const DELIVERED_KG = "4990";

test.describe.serial("definition-of-done flow", () => {
  test.setTimeout(180_000);

  const sessions = new Map<Role, { context: BrowserContext; page: Page }>();
  async function as(browser: Browser, role: Role): Promise<Page> {
    const existing = sessions.get(role);
    if (existing) return existing.page;
    const s = await rolePage(browser, role);
    sessions.set(role, s);
    return s.page;
  }

  test.afterAll(async () => {
    for (const s of sessions.values()) await s.context.close();
  });

  // Shared state across the serial steps.
  let supplierName = "";
  let purchaseUrl = "";
  let ourLotNumber = "";
  let ourLotHref = "";
  let maizeBeforeKg = 0;
  let customerName = "";
  let customerId = "";
  let orderUrl = "";
  let orderNumber = "";
  let dispatchUrl = "";
  let waybillNumber = "";
  let dispatchedLots: string[] = [];
  let invoiceUrl = "";
  let invoiceNumber = "";
  let invoiceTotalKobo = 0;

  test("procurement records an approved purchase at an allowed buying point", async ({ browser }) => {
    const page = await as(browser, "procurement");
    await page.goto("/purchases/new", { timeout: NAV_T });
    await expect(page.getByRole("heading", { name: "New purchase", level: 1 })).toBeVisible({ timeout: NAV_T });

    // Supplier: SupplierCombobox (#p-supplier, cmdk options) — use an existing seeded supplier.
    await page.locator("#p-supplier").click();
    const firstSupplier = page.getByRole("option").filter({ hasNotText: "Add new supplier" }).first();
    await expect(firstSupplier).toBeVisible({ timeout: T });
    supplierName = (await firstSupplier.locator("span.font-medium").first().innerText()).trim();
    await firstSupplier.click();
    await expect(page.locator("#p-supplier")).toContainText(supplierName);

    // Buying point (#p-point): a restricted officer only sees their points (preselected when one).
    const point = page.locator("#p-point");
    if (await point.isVisible()) {
      const current = (await point.innerText()).trim();
      if (!current || /No buying point|Pick your buying point/.test(current)) {
        await chooseFirstOption(page, point, /No buying point|Pick your buying point/);
      }
    }

    // Line 1 (LineEditor ids l0-*): Maize · Grade A, 100 bags, 10,000 kg gross, 50 kg moisture.
    await chooseOption(page, page.locator("#l0-commodity"), COMMODITY);
    await chooseOption(page, page.locator("#l0-grade"), GRADE);
    await page.locator("#l0-bags").fill(BAGS);
    await page.locator("#l0-gross").fill(GROSS_KG);
    await page.getByRole("button", { name: "Add deduction" }).click(); // defaults to reason "moisture"
    await page.getByLabel("Deduction 1 kg").fill(MOISTURE_DEDUCTION_KG);
    await page.locator("#l0-price").fill(await priceWithinGuide(page));

    await expect(page.getByText("9,950 kg").first()).toBeVisible({ timeout: T }); // live net weight
    await expect(page.getByText(/over guide/i)).toHaveCount(0);

    await page.getByRole("button", { name: "Save purchase" }).click();
    await page.waitForURL(new RegExp(`/purchases/${UUID}$`), { timeout: NAV_T });
    purchaseUrl = new URL(page.url()).pathname;

    await expect(badge(page, "Approved")).toBeVisible({ timeout: T });
    await expect(page.getByText("Within price guide")).toBeVisible({ timeout: T });
    await expect(page.getByText(supplierName).first()).toBeVisible();
  });

  test("manager receives it into Gombe Main → GRN issued, stock rises", async ({ browser }) => {
    const page = await as(browser, "manager");
    maizeBeforeKg = await stockKgFor(page, COMMODITY);

    await page.goto(purchaseUrl, { timeout: NAV_T });
    await page.getByRole("button", { name: "Receive into warehouse" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: /^Receive / })).toBeVisible({ timeout: T });

    const wh = dialog.locator("#rcv-wh");
    if (!(await wh.innerText()).includes(MAIN_WAREHOUSE)) await chooseOption(page, wh, MAIN_WAREHOUSE);
    await dialog.getByRole("button", { name: "Receive", exact: true }).click();

    const done = dialog.getByRole("heading", { name: /^Received · / });
    await expect(done).toBeVisible({ timeout: NAV_T });
    const grnNumber = (await done.innerText()).replace(/^Received · /, "").trim();
    expect(grnNumber).not.toBe("");

    const lotLink = dialog.getByRole("link").first();
    ourLotNumber = (await lotLink.innerText()).trim();
    ourLotHref = (await lotLink.getAttribute("href")) ?? "";
    expect(ourLotHref).toMatch(new RegExp(`^/stock/lots/${UUID}$`));
    await dialog.getByRole("button", { name: "Done" }).click();

    // GRN on the purchase page + received status.
    await expect(page.getByText("Goods received note")).toBeVisible({ timeout: T });
    await expect(page.getByText(grnNumber, { exact: true }).first()).toBeVisible();
    await expect(badge(page, "Received")).toBeVisible({ timeout: T });

    // /stock: maize total grew by the net weight and the new lot is listed.
    const after = await stockKgFor(page, COMMODITY);
    expect(after - maizeBeforeKg).toBeCloseTo(NET_KG, 3);

    const maize = detailsSummary(page, COMMODITY);
    const maizeDetails = maize.locator("xpath=..");
    if ((await maizeDetails.getAttribute("open")) === null) await maize.click();
    await detailsSummary(maizeDetails, GRADE).click();
    await expect(
      maizeDetails.getByRole("link", { name: new RegExp(escapeRegExp(ourLotNumber)) }),
    ).toBeVisible({ timeout: T });
  });

  test("sales creates, confirms, FIFO-allocates and dispatches a sale", async ({ browser }) => {
    const page = await as(browser, "sales");
    await page.goto("/sales/new", { timeout: NAV_T });
    await expect(page.getByRole("heading", { name: "New sale", level: 1 })).toBeVisible({ timeout: NAV_T });

    customerName = await chooseFirstOption(page, page.locator("#so-customer"));
    await chooseOption(page, page.locator("#l0-commodity"), COMMODITY);
    await chooseOption(page, page.locator("#l0-grade"), GRADE);
    await page.locator("#l0-kg").fill(SALE_KG);
    await page.locator("#l0-price").fill(SALE_PRICE_NAIRA);
    await page.getByRole("button", { name: "Save & confirm" }).click();

    await page.waitForURL(new RegExp(`/sales/${UUID}$`), { timeout: NAV_T });
    orderUrl = new URL(page.url()).pathname;
    orderNumber = (await page.getByRole("heading", { level: 1 }).innerText()).trim();
    await expect(badge(page, "Confirmed")).toBeVisible({ timeout: T });
    customerId =
      (await page.getByRole("link", { name: "View customer" }).getAttribute("href"))?.split("/").pop() ?? "";
    expect(customerId).toMatch(new RegExp(`^${UUID}$`));

    await page.getByRole("button", { name: "Auto-allocate (FIFO)" }).click();
    const dispatchBtn = page.getByRole("button", { name: /^Dispatch [\d,.]+ kg$/ });
    await expect(dispatchBtn).toBeVisible({ timeout: NAV_T });
    await expect(dispatchBtn).toHaveText(/5,000 kg/);

    await chooseFirstOption(page, page.locator("#dsp-vehicle"), /^No vehicle$/);
    await chooseFirstOption(page, page.locator("#dsp-driver"), /^No driver$/);
    await dispatchBtn.click();

    const created = page.getByText(/Dispatched\. Waybill/);
    await expect(created).toBeVisible({ timeout: NAV_T });
    waybillNumber = (await created.locator("span").first().innerText()).trim();
    expect(waybillNumber).not.toBe("pending");

    await page.getByRole("link", { name: "Open waybill" }).click();
    await page.waitForURL(new RegExp(`/dispatches/${UUID}$`), { timeout: NAV_T });
    dispatchUrl = new URL(page.url()).pathname;
    await expect(page.getByRole("heading", { name: waybillNumber, level: 1 })).toBeVisible({ timeout: T });
    await expect(badge(page, "In transit")).toBeVisible();

    const lines = page.getByRole("region", { name: "Lines" }).getByRole("listitem");
    await expect(lines.first()).toBeVisible({ timeout: T });
    dispatchedLots = (await lines.locator("p.font-medium").allInnerTexts()).map((s) => s.trim());
    expect(dispatchedLots.length).toBeGreaterThan(0);
  });

  test("manager records delivery of 4,990 kg → transit loss shown", async ({ browser }) => {
    const page = await as(browser, "manager");
    await page.goto(dispatchUrl, { timeout: NAV_T });
    await page.locator("#dlv-kg").fill(DELIVERED_KG);
    await expect(page.getByText("10 kg (0.20%)")).toBeVisible({ timeout: T });
    await page.getByRole("button", { name: "Record delivery" }).click();

    await expect(badge(page, "Delivered")).toBeVisible({ timeout: NAV_T });
    await expect(page.getByText(/Transit loss 10 kg/)).toBeVisible({ timeout: T });
    await expect(statValue(page.getByRole("region", { name: "Waybill" }), "Delivered")).toHaveText("4,990 kg");
  });

  test("sales creates the invoice from the dispatch", async ({ browser }) => {
    const page = await as(browser, "sales");
    await page.goto(dispatchUrl, { timeout: NAV_T });
    // CreateInvoiceForm: first "Create invoice" opens the form, the second submits it.
    await page.getByRole("button", { name: "Create invoice" }).click();
    await expect(page.locator("#inv-date")).toBeVisible({ timeout: T });
    await page.getByRole("button", { name: "Create invoice" }).click();

    await page.waitForURL(new RegExp(`/invoices/${UUID}$`), { timeout: NAV_T });
    invoiceUrl = new URL(page.url()).pathname;
    invoiceNumber = (await page.getByRole("heading", { level: 1 }).innerText()).trim();
    await expect(badge(page, "Issued")).toBeVisible({ timeout: T });

    const amounts = page.getByRole("region", { name: "Amounts" });
    invoiceTotalKobo = parseNairaToKobo(await statValue(amounts, "Total").innerText()) ?? 0;
    // Invoices bill the dispatched weight: 5,000 kg × ₦2,000 (tax off by default).
    expect(invoiceTotalKobo).toBe(5000 * 2000 * 100);
  });

  test("accountant records the full customer payment → invoice paid", async ({ browser }) => {
    const page = await as(browser, "accountant");
    await page.goto(invoiceUrl, { timeout: NAV_T });
    await page.getByRole("link", { name: "Record payment" }).click();
    await page.waitForURL(/\/customer-payments\?customerId=/, { timeout: NAV_T });

    await expect(page.locator("#pay-customer")).toContainText(customerName, { timeout: T });
    const amount = koboToNairaInput(invoiceTotalKobo);
    await page.locator("#pay-amount").fill(amount);
    // Allocate to THIS invoice explicitly (the seeded customer may have older open invoices).
    const auto = page.getByRole("switch", { name: "Auto-allocate oldest invoice first" });
    await auto.click();
    await expect(auto).toHaveAttribute("aria-checked", "false");
    await page.getByLabel(`Amount for ${invoiceNumber}`).fill(amount);
    await page.getByRole("button", { name: /^Record payment of ₦/ }).click();
    await expect(page.getByText(/Payment .+ recorded/).first()).toBeVisible({ timeout: NAV_T });

    await page.goto(invoiceUrl, { timeout: NAV_T });
    await expect(badge(page, "Paid")).toBeVisible({ timeout: T });
    const amounts = page.getByRole("region", { name: "Amounts" });
    await expect(statValue(amounts, "Outstanding")).toHaveText("₦0.00");
  });

  test("margin report shows the sale with a positive margin", async ({ browser }) => {
    const page = await as(browser, "accountant");
    await page.goto(`/reports/margin?by=sale&customerId=${customerId}`, { timeout: NAV_T });
    await expect(page.getByRole("heading", { name: "Margin by sale", level: 1 })).toBeVisible({ timeout: NAV_T });

    // Below md the report renders stacked cards: title = order number, dt/dd pairs.
    const card = page
      .getByRole("listitem")
      .filter({ has: page.getByText(orderNumber, { exact: true }) })
      .filter({ visible: true })
      .first();
    await expect(card).toBeVisible({ timeout: T });
    const dd = (label: string) =>
      card
        .locator("dt", { hasText: new RegExp(`^${escapeRegExp(label)}$`) })
        .first()
        .locator("xpath=following-sibling::dd[1]");
    await expect(dd("Customer")).toHaveText(customerName);
    const marginKobo = parseNairaToKobo(await dd("Margin").innerText());
    expect(marginKobo).not.toBeNull();
    expect(marginKobo!).toBeGreaterThan(0);
    expect(parseKg(await dd("Dispatched kg").innerText())).toBeCloseTo(5000, 3);
  });

  test("lot trace: the dispatched lot leads back to its supplier and on to the customer", async ({ browser }) => {
    const page = await as(browser, "accountant");

    // Sale → suppliers (SaleTracePanel on the order page).
    await page.goto(orderUrl, { timeout: NAV_T });
    const tracePanel = page.getByRole("region", { name: "Suppliers behind this sale" });
    const supplierLinks = tracePanel.getByRole("link");
    await expect(supplierLinks.first()).toBeVisible({ timeout: NAV_T });
    const saleSuppliers = (await supplierLinks.allInnerTexts()).map((s) => s.trim());

    // Lot page of the first dispatched lot (reached via the newest dispatch movements).
    const lotNumber = dispatchedLots[0];
    await page.goto("/movements?type=dispatch", { timeout: NAV_T });
    await page
      .getByRole("link", { name: lotNumber, exact: true })
      .filter({ visible: true })
      .first()
      .click();
    await page.waitForURL(new RegExp(`/stock/lots/${UUID}$`), { timeout: NAV_T });
    await expect(page.getByRole("heading", { name: `Lot ${lotNumber}`, level: 1 })).toBeVisible({ timeout: T });

    const lotSupplier = (await statValue(page, "Supplier").innerText()).trim();
    expect(lotSupplier).not.toBe("");
    expect(saleSuppliers).toContain(lotSupplier);

    await expect(page.getByText("Where it went")).toBeVisible({ timeout: T });
    await expect(page.getByRole("link", { name: new RegExp(escapeRegExp(customerName)) }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: waybillNumber, exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: orderNumber, exact: true })).toBeVisible();

    // And the lot received in this run traces to the supplier we bought from.
    await page.goto(ourLotHref, { timeout: NAV_T });
    await expect(page.getByRole("heading", { name: `Lot ${ourLotNumber}`, level: 1 })).toBeVisible({ timeout: T });
    await expect(statValue(page, "Supplier")).toHaveText(supplierName);
  });
});
