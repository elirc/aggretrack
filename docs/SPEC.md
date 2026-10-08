# AggreTrack — Product Specification

AggreTrack is the operations system for an agricultural aggregation business: one that buys produce from many farmers and agents, stores it, and sells it to buyers who cannot reach those farmers. It answers three questions at any moment: who did I buy from and how much, what is in each warehouse, and who did I sell to at what margin.

## Assumptions

- This is an internal operations tool sold as multi-tenant software. The owner's business is the first organisation; other aggregators can subscribe later.
- Each organisation sets up its own commodities and grades (for example maize, soybean, rice paddy, sorghum, sesame, ginger, cashew).
- Produce is bought by the bag and by weight. A purchase line records bags, gross weight, deductions (moisture, foreign matter, sack weight) and net weight.
- Every purchase line creates a lot. Stock is tracked and costed per lot, so any sale can be traced back to the suppliers it came from.
- Sales take stock from the oldest lots first unless the user picks lots by hand.
- A lot's cost per kg is its purchase price plus its share of inbound transport and handling, shared by weight.
- Paying farmers in advance is common, so supplier advances and balances are tracked.
- Payments are recorded, not processed. Staff enter cash, transfer or POS payments by hand. There is no bank integration.
- This is not an accounting system. There is no general ledger, tax filing or payroll. Reports export to Excel for an accountant.
- Invoices have an optional tax line that is off by default.
- Logistics means trip records (vehicle, driver, route, cost) for inbound and outbound loads. There is no GPS tracking or route planning.
- Weights are typed in. There is no weighbridge or scale connection.
- Buying happens where the network is poor, so purchases and stock receipts can be entered offline on a phone and sync later.
- Market: Nigeria first. Single currency (Naira), Africa/Lagos time, metric units. Staff mostly use Android phones.
- A phone number is the main login, verified by a one-time code. The language is English.
- Web only: no native mobile apps in version one.
- Pricing is a placeholder: a monthly subscription per organisation with a 14-day free trial and a user limit per plan.

## Roles

- Owner: everything, including billing, users and approvals.
- Manager: all operations, approvals, reports.
- Procurement officer: suppliers, purchases, advances. Sees only their own buying points if restricted.
- Warehouse keeper: receipts, transfers, counts, dispatches for assigned warehouses. Sees no prices if the owner hides them.
- Sales officer: customers, sales orders, invoices.
- Accountant: records payments and expenses, reads everything, exports reports.
- Platform admin: organisations, plans and system health across tenants.

## Tech stack

Use this stack. If a library has changed, use its current stable version and note the change in the README.

- TypeScript in strict mode, Node.js LTS, pnpm.
- Next.js latest stable with the App Router: Server Components for reads, Server Actions for mutations, route handlers for webhooks and sync.
- PostgreSQL, Drizzle ORM, drizzle-kit migrations.
- Better Auth: phone number with OTP, email and password, and the organization plugin for tenants and roles.
- Tailwind CSS and shadcn/ui, react-hook-form with Zod, TanStack Table, Recharts.
- pg-boss for queues and scheduled jobs, run by a separate worker process in the same repo.
- Serwist for an installable PWA, with Dexie (IndexedDB) for an offline queue of purchases, receipts and dispatches.
- React-PDF (@react-pdf/renderer) for goods received notes, waybills, invoices and statements. ExcelJS for exports.
- Adapters in src/adapters, each with a mock driver and a real driver chosen by env: SMS (Termii), email (Resend), subscription payments (Paystack), file storage (S3-compatible or local disk).
- Vitest for unit tests, Playwright for end-to-end tests, ESLint and Prettier.
- Docker Compose with web, worker and db, plus a documented .env.example.

## Engineering rules

- Store money as integer kobo and weights in kilograms with three decimal places. Store timestamps in UTC and display them in Africa/Lagos.
- Stock changes only through rows in an append-only stock_movements table. Stock on hand is always the sum of movements. Corrections are new movements, never edits.
- Post each stock or payment transaction inside one database transaction with row locks. Stock can never go negative.
- Every record created offline carries a client-generated UUID. The sync endpoint is idempotent, so a retry never creates a duplicate.
- Check permissions on the server in every action. Scope every query by organisation. Include a test that one organisation cannot read another's data.
- Validate all input with Zod. Rate-limit OTP requests. Verify Paystack webhook signatures.
- Write an audit log row for every create, update, cancel and approval, with before and after values.
- Documents get gapless numbers per organisation and year, such as GRN-2026-00001.
- Build mobile-first at 360 px width. Entry forms must work one-handed on a phone. Every screen has loading, empty and error states.
- In mock mode the OTP is always 123456 and no external call is made. The app must refuse to start in production with mock auth enabled.
- Before coding each external integration, check its current documentation for endpoint and field names. Do not guess.

## Data model

Create these tables, with sensible indexes and foreign keys. Every business table carries organisation_id.

- organisations, users, memberships (role, allowed warehouses and buying points), plans, subscriptions.
- Master data: commodities, grades, bag_types (name, standard kg, sack weight), buying_points, warehouses (capacity), bins, vehicles, drivers, expense_categories.
- price_guides: commodity, grade, buying point, date, maximum buying price per kg.
- suppliers: type (farmer, agent, cooperative), name, phone, village, LGA, state, bank details, ID note, photo.
- supplier_advances and supplier_payments, with payment_allocations linking a payment to purchases or advances.
- purchases (supplier, date, buying point, officer, status) and purchase_lines (commodity, grade, bags, gross kg, deduction kg by reason, net kg, moisture percent, price per kg, amount).
- lots: lot number, commodity, grade, supplier, purchase line, received date, original kg, cost per kg, landed cost per kg.
- stock_movements: lot, warehouse, bin, type (receive, transfer out, transfer in, adjustment, dispatch, return), kg, bags, reference document, user, time.
- transfers (from, to, status including in transit), stock_counts and count_lines, adjustments (reason: shrinkage, spoilage, theft, re-bagging, count difference; approval status).
- customers, sales_orders and sales_lines, lot_allocations (sales line, lot, kg), dispatches (waybill number, vehicle, driver, dispatched kg, delivered kg), invoices, customer_payments with allocations.
- trips (direction, vehicle, driver, origin, destination, date, cost, linked purchases or dispatches) and expenses (category, amount, linked to a lot, trip or warehouse).
- documents (generated PDFs), notifications, audit_log.

## Modules

### Buying

- Quick purchase entry on a phone: pick or add a supplier, add lines, see the amount, save. Works offline.
- Warn when a price is above the day's price guide. A price over the guide needs manager approval.
- Receiving a purchase into a warehouse creates lots and stock movements and produces a goods received note as a PDF.
- Optionally send the supplier an SMS receipt with quantity and amount, and another when they are paid.
- Supplier page: profile, purchase history, quality deductions over time, advances, payments, balance owed either way, printable statement.
- Payables list with ageing: what is owed to each supplier and for how long.

### Warehouse

- Stock position by commodity, grade and warehouse, with a drill-down to lots and bins. Show kg, bags and value.
- Stock ageing in bands of 0 to 30, 31 to 60, 61 to 90 and over 90 days.
- Transfers between warehouses with an in-transit state and a receipt step that records any loss.
- Stock counts: enter counted bags and kg per lot or bin, see the difference, post adjustments. Adjustments above a set weight need approval.
- Alerts for low stock, old stock and warehouses near capacity.
- A movement history for any lot, warehouse or date range.

### Selling

- Sales order for a customer with lines by commodity, grade, kg and price.
- Allocate lots automatically, oldest first, or by hand. Allocation reserves stock.
- Dispatch creates stock movements and a waybill PDF with vehicle and driver. Record delivered weight on arrival; the gap is transit loss.
- Invoice PDF from a dispatch. Record customer payments and allocate them to invoices.
- Receivables list with ageing, and a printable customer statement.

### Logistics and costs

- Trips for inbound collection and outbound delivery, with cost, vehicle and driver.
- Inbound trip cost and handling expenses are shared across the trip's lots by weight to give landed cost per kg.
- Other expenses (storage, fumigation, loading, bagging) are recorded by category and can be attached to a lot or warehouse.

### Traceability and margin

- A lot page shows the supplier, purchase, every movement and every customer it went to.
- A sale page lists the suppliers whose produce went into it.
- Margin per lot, per sale, per customer and per commodity: revenue minus landed cost minus attached expenses.

### Dashboard and reports

- Dashboard: stock value, purchases and sales this week and month, owed to suppliers, owed by customers, gross margin, top suppliers and customers, alerts.
- Reports with date and filter controls, each exportable to Excel and PDF: purchases by supplier, commodity and period; stock position as at any date; stock movements; sales by customer; margin; payables ageing; receivables ageing; supplier performance; shrinkage and losses; trip costs.

### Setup and admin

- Organisation setup wizard: commodities, grades, bag types, warehouses, buying points, users.
- CSV import for suppliers, customers and opening stock, with a preview and row-level errors.
- Users and roles, including warehouse and buying point restrictions and a switch that hides prices from warehouse keepers.
- Billing page using Paystack subscriptions with hosted checkout and a webhook. After the trial or a failed payment the organisation becomes read-only, never deleted.
- Platform admin: organisations, plans, usage, audit log.

## Build phases

1. Scaffold, Docker, auth, organisations, roles and restrictions, master data, setup wizard, seed script.
2. Suppliers, price guides, purchases, lots, goods received notes, advances, supplier payments, payables.
3. Stock movements, stock position and ageing, transfers, counts, adjustments with approval, alerts.
4. Customers, sales orders, allocation, dispatches and waybills, invoices, customer payments, receivables.
5. Trips, expenses, landed cost, traceability, margin, dashboard, reports and exports.
6. Offline queue and sync, SMS receipts, CSV import, billing, platform admin, end-to-end tests, README.

## Definition of done

- docker compose up followed by the seed script gives a working app with a demo organisation, a login for each role, 40 suppliers, 8 customers, 2 warehouses and three months of purchases, sales and payments.
- Unit tests cover net weight and amount, oldest-first allocation, landed cost sharing by weight, payment allocation, margin, and ageing bands.
- A test proves that stock on hand equals the sum of movements after every flow, and that an oversell is rejected under concurrent requests.
- A test proves that replaying the same offline purchase twice creates one purchase.
- An end-to-end test covers: record a purchase, receive it, see stock rise, create a sale, dispatch, invoice, record payment, and see the margin report and the trace from sale back to supplier.
- Typecheck, lint and all tests pass. The README is complete and includes the Assumptions section.
