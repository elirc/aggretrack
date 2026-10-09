// Whole-UI audit against the running AggreTrack production server.
// Logs in per role, visits every route at desktop + mobile widths,
// records console errors/warnings, page errors and failed same-origin
// requests, and screenshots each page.
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE = "http://localhost:4137";
const OUT = path.resolve(process.argv[2] ?? "./audit-out");
fs.mkdirSync(OUT, { recursive: true });

const OWNER_ROUTES = [
  "/", "/purchases", "/purchases/new", "/suppliers", "/suppliers/new",
  "/advances", "/supplier-payments", "/payables", "/price-guides",
  "/stock", "/stock/ageing", "/movements", "/transfers", "/transfers/new",
  "/counts", "/counts/new", "/adjustments", "/adjustments/new",
  "/sales", "/sales/new", "/customers", "/dispatches", "/invoices",
  "/customer-payments", "/receivables", "/trips", "/trips/new",
  "/expenses", "/alerts", "/reports", "/reports/margin",
  "/reports/stock-position", "/reports/payables-ageing",
  "/settings", "/settings/master-data", "/settings/users",
  "/settings/audit", "/settings/billing", "/settings/import", "/onboarding",
];
// list route -> detail href pattern to follow (first match)
const DETAILS = {
  "/purchases": /^\/purchases\/[0-9a-f-]{36}$/,
  "/suppliers": /^\/suppliers\/[0-9a-f-]{36}$/,
  "/sales": /^\/sales\/[0-9a-f-]{36}$/,
  "/invoices": /^\/invoices\/[0-9a-f-]{36}$/,
  "/dispatches": /^\/dispatches\/[0-9a-f-]{36}$/,
  "/transfers": /^\/transfers\/[0-9a-f-]{36}$/,
  "/counts": /^\/counts\/[0-9a-f-]{36}$/,
  "/trips": /^\/trips\/[0-9a-f-]{36}$/,
  "/customers": /^\/customers\/[0-9a-f-]{36}$/,
  "/movements": /^\/stock\/lots\/[0-9a-f-]{36}$/,
};
const PLATFORM_ROUTES = ["/platform", "/platform/organisations", "/platform/plans", "/platform/audit"];
const PUBLIC_ROUTES = ["/login", "/register"];

const report = [];

function slug(route) {
  return route === "/" ? "dashboard" : route.replace(/^\//, "").replace(/[\/?=&]/g, "_");
}

async function login(page, email) {
  await page.goto(BASE + "/login", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.getByRole("tab", { name: "Email" }).click();
  await page.locator("#email").fill(email);
  await page.locator("#password").fill("demo1234");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => new URL(u).pathname === "/", { timeout: 60000 });
}

async function auditPage(context, route, mobile, label) {
  const page = await context.newPage();
  const entry = { label, route, mobile: !!mobile, console: [], pageErrors: [], badResponses: [], finalUrl: "", note: "" };
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") {
      const t = m.text();
      if (!/Download the React DevTools|third-party cookie|Preload|preload/i.test(t))
        entry.console.push(`${m.type()}: ${t.slice(0, 300)}`);
    }
  });
  page.on("pageerror", (e) => entry.pageErrors.push(String(e).slice(0, 300)));
  page.on("response", (r) => {
    try {
      const u = new URL(r.url());
      if (u.origin === BASE && r.status() >= 400)
        entry.badResponses.push(`${r.status()} ${r.request().method()} ${u.pathname}`);
    } catch {}
  });
  if (mobile) await page.setViewportSize({ width: 360, height: 740 });
  else await page.setViewportSize({ width: 1280, height: 850 });
  try {
    await page.goto(BASE + route, { waitUntil: "load", timeout: 90000 });
    await page.waitForTimeout(1600);
    entry.finalUrl = new URL(page.url()).pathname;
    // horizontal scroll check on mobile
    if (mobile) {
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (over > 2) entry.note = `horizontal overflow ${over}px`;
    }
    const shot = path.join(OUT, `${label}-${slug(route)}${mobile ? "-m" : ""}.png`);
    await page.screenshot({ path: shot, fullPage: false });
    entry.screenshot = path.basename(shot);
    // follow one detail link from list pages (desktop pass only)
    const pat = DETAILS[route];
    if (pat && !mobile) {
      const hrefs = await page.$$eval("a[href]", (as) => as.map((a) => a.getAttribute("href")));
      const d = hrefs.find((h) => h && pat.test(h));
      if (d) {
        const sub = await auditPage(context, d, false, label);
        report.push(sub);
      } else {
        entry.note += " no-detail-link-found";
      }
    }
  } catch (e) {
    entry.note = "NAV FAIL: " + String(e).slice(0, 200);
  }
  await page.close();
  return entry;
}

const browser = await chromium.launch();
try {
  // Owner pass: desktop + mobile
  const owner = await browser.newContext({ baseURL: BASE });
  await login(await owner.newPage().then((p) => p), "owner@demo.aggretrack.local").catch(async (e) => {
    console.error("owner login failed", e);
    process.exit(2);
  });
  for (const r of OWNER_ROUTES) report.push(await auditPage(owner, r, false, "owner"));
  for (const r of OWNER_ROUTES) report.push(await auditPage(owner, r, true, "owner"));
  await owner.close();

  // Platform admin pass
  const plat = await browser.newContext({ baseURL: BASE });
  {
    const p = await plat.newPage();
    await p.goto(BASE + "/login", { waitUntil: "domcontentloaded", timeout: 60000 });
    await p.getByRole("tab", { name: "Email" }).click();
    await p.locator("#email").fill("platform@demo.aggretrack.local");
    await p.locator("#password").fill("demo1234");
    await p.getByRole("button", { name: "Sign in" }).click();
    await p.waitForTimeout(4000); // platform admin may land on /register (no org) — fine
    await p.close();
  }
  for (const r of PLATFORM_ROUTES) report.push(await auditPage(plat, r, false, "platform"));
  await plat.close();

  // Public pages
  const anon = await browser.newContext({ baseURL: BASE });
  for (const r of PUBLIC_ROUTES) {
    report.push(await auditPage(anon, r, false, "anon"));
    report.push(await auditPage(anon, r, true, "anon"));
  }
  await anon.close();
} finally {
  await browser.close();
}

fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
const issues = report.filter((e) => e.console.length || e.pageErrors.length || e.badResponses.length || e.note);
console.log(`AUDITED ${report.length} page-views; ${issues.length} with findings`);
for (const e of issues) {
  console.log(`--- ${e.label} ${e.route}${e.mobile ? " [360px]" : ""} -> ${e.finalUrl} ${e.note}`);
  for (const c of e.console.slice(0, 4)) console.log("   console", c);
  for (const p of e.pageErrors.slice(0, 3)) console.log("   pageerror", p);
  for (const b of e.badResponses.slice(0, 4)) console.log("   http", b);
}
