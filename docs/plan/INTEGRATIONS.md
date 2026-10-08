# INTEGRATIONS.md — verified external-API reference card

Researched 2026-10-08 against official docs + npm registry. Implementer agents: trust this file over memory.
Anything marked **UNVERIFIED** must be checked against installed `node_modules` docs/types before use.

## 0. Pinned current versions (npm dist-tag `latest`, fetched 2026-10-08)

| Package | Version | Notes |
|---|---|---|
| next | **16.4.0** | Turbopack is default bundler; `--webpack` flag opts out |
| better-auth | **1.7.7** | Drizzle adapter is now a separate package (below) |
| @better-auth/drizzle-adapter | (install latest) | NEW — no longer `better-auth/adapters/drizzle` |
| drizzle-orm | **0.45.4** | v1.0 still beta — use 0.45.x |
| drizzle-kit | **0.31.11** | commands: `generate`, `migrate`, `push` |
| pg | 8.23.1 | node-postgres Pool |
| pg-boss | **12.37.0** | major v12 — API below; needs Node >= 22.12 (box has 22.16.0 ✓) |
| serwist / @serwist/next | **9.5.13** | webpack-oriented; Turbopack caveat below |
| @react-pdf/renderer | **4.9.0** | renderToBuffer/renderToStream |
| exceljs | 4.4.0 | |
| dexie | 4.4.6 / dexie-react-hooks 4.4.0 | |
| resend | **6.32.1** | |
| zod | **4.6.5** | Zod v4 — `import { z } from "zod"` |
| react-hook-form | 7.89.0 | |
| @hookform/resolvers | **5.9.1** | v5 supports zod v4 (`zodResolver`) |
| @tanstack/react-table | **9.2.6** | ⚠️ v9 is latest; most docs/shadcn recipes target v8. UNVERIFIED v9 API deltas — either pin `@tanstack/react-table@8` or verify v9 docs before building tables. Note choice in README. |
| recharts | 3.10.1 | v3 |
| tailwindcss | **4.3.3** | v4 — CSS-first config (`@import "tailwindcss"`, `@theme`) |
| shadcn (CLI) | 4.21.4 | `pnpm dlx shadcn@latest init` / `add <component>` |
| vitest | **5.0.3** | ⚠️ major v5 — config shape largely as v3/v4 but UNVERIFIED; check release notes or pin v4.1.x if friction |
| @playwright/test | 1.64.0 | |

## 1. Better Auth 1.7.7

### Drizzle adapter (NEW package)
```ts
import { drizzleAdapter } from "@better-auth/drizzle-adapter"; // pnpm add @better-auth/drizzle-adapter
export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg", schema: { ...schema } }),
  // usePlural: true inside adapter options if tables are plural
});
```
Schema generation CLI (docs now say): `npx auth@latest generate` (equivalently `pnpm dlx auth@latest generate`). Older `npx @better-auth/cli@latest generate` may still exist — UNVERIFIED. Generates e.g. `auth-schema.ts`; then `npx drizzle-kit generate` + `npx drizzle-kit migrate`.

### phoneNumber plugin (server)
```ts
import { phoneNumber } from "better-auth/plugins";
phoneNumber({
  otpLength: 6,            // default 6
  expiresIn: 300,          // seconds, default 300
  allowedAttempts: 3,      // default 3; then 403 "Too many attempts"
  sendOTP: ({ phoneNumber, code }, ctx) => { /* fire-and-forget SMS — do NOT await */ },
  sendPasswordResetOTP: ({ phoneNumber, code }, ctx) => {},
  phoneNumberValidator: (phone) => boolean,
  requireVerification: true, // unverified sign-in → 401 PHONE_NUMBER_NOT_VERIFIED + auto OTP
  signUpOnVerification: { getTempEmail: (phone) => string, getTempName?: (phone) => string },
  callbackOnVerification: async ({ phoneNumber, user }, ctx) => {},
})
```
Adds 2 fields to `user` table (names rendered client-side in docs; expect `phoneNumber` + `phoneNumberVerified` — confirm from generated schema, UNVERIFIED).

### phoneNumber client
```ts
import { phoneNumberClient } from "better-auth/client/plugins";
await authClient.phoneNumber.sendOtp({ phoneNumber });
await authClient.phoneNumber.verify({ phoneNumber, code, disableSession?, updatePhoneNumber? });
await authClient.signIn.phoneNumber({ phoneNumber, password, rememberMe? }); // needs account row providerId "credential"
await authClient.phoneNumber.requestPasswordReset({ phoneNumber });
await authClient.phoneNumber.resetPassword({ otp, phoneNumber, newPassword });
```
Server API: `auth.api.sendPhoneNumberOTP({ body: { phoneNumber } })`, `auth.api.verifyPhoneNumber({ body: { phoneNumber, code, ... } })`, `auth.api.signInPhoneNumber(...)`, plus server-only `auth.api.consumePhoneNumberOTP({ body: { phoneNumber, code } })`.

### organization plugin
Server: `organization({ ac, roles: { owner, manager, ... }, allowUserToCreateOrganization, membershipLimit (default 100), creatorRole: "owner", sendInvitationEmail, invitationExpiresIn })`.
Custom roles:
```ts
import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements, adminAc } from "better-auth/plugins/organization/access";
const statement = { ...defaultStatements, purchase: ["create","approve"], /* ... */ } as const;
const ac = createAccessControl(statement);
const manager = ac.newRole({ purchase: ["create","approve"], ...adminAc.statements });
```
Pass the same `ac` + `roles` to `organizationClient({ ac, roles })`.
Tables added: `organization`, `member`, `invitation`, and `session.activeOrganizationId` field.
Key APIs (client `authClient.organization.*` / server `auth.api.*`):
create/createOrganization, setActive/setActiveOrganization({ organizationId }), getFullOrganization, list/listOrganizations, inviteMember/createInvitation({ email, role }), acceptInvitation({ invitationId }), listMembers, **addMember (server-only: `auth.api.addMember({ body: { userId, role } })`)**, removeMember({ memberIdOrEmail }), updateMemberRole({ role, memberId }), getActiveMember, leave/leaveOrganization, hasPermission({ permissions: { purchase: ["approve"] } }), checkRolePermission (client, sync, static roles only).
Server calls take `headers: await headers()`.

### Next.js integration
```ts
// app/api/auth/[...all]/route.ts
import { toNextJsHandler } from "better-auth/next-js";
export const { GET, POST } = toNextJsHandler(auth);
// server component / action:
const session = await auth.api.getSession({ headers: await headers() });
// cookie-only fast check (NOT validation): import { getSessionCookie } from "better-auth/cookies";
// Server Actions that set cookies need plugin: import { nextCookies } from "better-auth/next-js"; plugins: [..., nextCookies()] // must be LAST
```

### Rate limiting
Built-in `rateLimit: { enabled: true, window: 60, max: 10, customRules: { "/phone-number/send-otp": { window: 60, max: 3 } } }` — shape UNVERIFIED (from memory); check better-auth.com/docs/concepts/rate-limit or installed types. Storage defaults to memory; set `rateLimit.storage: "database"` for multi-instance.

## 2. Termii SMS (real driver for SMS adapter)

- Base URL: `https://api.ng.termii.com` (account-specific base possible — make it env-configurable `TERMII_BASE_URL`).
- **POST `/api/sms/send`**, `Content-Type: application/json`. Auth = `api_key` **in the JSON body** (not a header).
```json
{ "api_key": "...", "to": "2348012345678", "from": "AggreTrack", "sms": "text", "type": "plain", "channel": "dnd" }
```
- `to`: international format without `+` (e.g. 234...); string or array (≤100). `from`: sender ID 3–11 alphanumeric chars (must be registered with Termii). `type`: `"plain"`. `channel`: `"dnd"` for transactional (delivers despite DND), `"generic"` promotional.
- 200 response: `{ "code": "ok", "message_id": "...", "message": "Successfully Sent", "balance": 1047.57, "user": "..." }`.

## 3. Resend (email adapter)

```ts
import { Resend } from "resend"; // v6
const resend = new Resend(process.env.RESEND_API_KEY);
const { data, error } = await resend.emails.send({
  from: "AggreTrack <noreply@yourdomain.com>", to: ["user@example.com"],
  subject: "...", html: "<p>...</p>", // or react: <Component/>, or text
});
// data: { id: string } | error: { message, name }
```
Field names (`from`,`to`,`subject`,`html`,`text`,`react`,`cc`,`bcc`,`reply_to`) — v6 verified-by-version; double-check `reply_to` vs `replyTo` in installed types (UNVERIFIED casing).

## 4. Paystack (subscription billing adapter)

Base `https://api.paystack.co`, header `Authorization: Bearer <SECRET_KEY>` (sk_test_... in test mode), `Content-Type: application/json`. **All amounts in kobo.**

- **Create plan**: `POST /plan` body `{ name, interval: "monthly", amount: 5000000, currency: "NGN" }` → `data.plan_code` ("PLN_xxx"). Intervals: daily|weekly|monthly|quarterly|biannually|annually.
- **Hosted checkout for a subscription**: `POST /transaction/initialize` body `{ email, amount, plan: "PLN_xxx", callback_url?, metadata? }` — the `plan` key (confirmed by official subscriptions guide); plan's amount overrides `amount`. Response `data: { authorization_url, access_code, reference }` → redirect user to `authorization_url`.
- **Verify a transaction**: `GET /transaction/verify/:reference` → `data.status === "success"`.
- **Disable (cancel) subscription**: `POST /subscription/disable` body `{ code: "SUB_xxx", token: "<email_token>" }`. Store `subscription_code` AND `email_token` from the `subscription.create` webhook. Re-enable: `POST /subscription/enable` same body.
- **Webhook**: Paystack POSTs JSON `{ event, data }`. Verify: header **`x-paystack-signature`** = hex HMAC-SHA512 of the **raw request body** keyed with your **secret key** (no separate webhook secret). Respond 200 fast (30s timeout; retries ~3min then hourly up to 72h) — handlers must be idempotent.
```ts
import crypto from "node:crypto";
const expected = crypto.createHmac("sha512", secretKey).update(rawBody).digest("hex");
const ok = expected.length === sig.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
```
- Subscription events: `subscription.create` (grab subscription_code + email_token), `charge.success` (first + renewal payments), `invoice.create`, `invoice.update`, `invoice.payment_failed`, `subscription.disable` (fully stopped), `subscription.not_renew` (active until period end). Event payload field names beyond these — UNVERIFIED; log raw payloads in dev and parse defensively.

## 5. Serwist 9.5.13 (PWA)

```js
// next.config.mjs
import withSerwistInit from "@serwist/next";
const withSerwist = withSerwistInit({ swSrc: "app/sw.ts", swDest: "public/sw.js", disable: process.env.NODE_ENV === "development" });
export default withSerwist(nextConfig);
```
```ts
// app/sw.ts
import { defaultCache } from "@serwist/next/worker";
import { Serwist } from "serwist";
declare global { interface WorkerGlobalScope extends SerwistGlobalConfig { __SW_MANIFEST: (PrecacheEntry | string)[] | undefined; } }
declare const self: ServiceWorkerGlobalScope;
const serwist = new Serwist({ precacheEntries: self.__SW_MANIFEST, skipWaiting: true, clientsClaim: true, navigationPreload: true, runtimeCaching: defaultCache,
  fallbacks: { entries: [{ url: "/~offline", matcher({ request }) { return request.destination === "document"; } }] } });
serwist.addEventListeners();
```
tsconfig: add `"@serwist/next/typings"` to `types`, `"webworker"` to `lib`, exclude `public/sw.js`. `.gitignore`: `public/sw*`, `public/swe-worker*`. Manifest at `app/manifest.json` (name, short_name, icons 192 maskable + 512, theme_color, background_color, start_url "/", display "standalone").
⚠️ **Turbopack caveat (Next 16 defaults to Turbopack):** @serwist/next getting-started is "meant for webpack"; a separate Turbopack guide exists on serwist.pages.dev but was not reachable (UNVERIFIED). Safe path: build with `next build --webpack` (and note it in README), or check the Serwist docs/installed package for Turbopack support once installed. Dev with turbopack is fine when `disable: true` in dev.

## 6. @react-pdf/renderer 4.9.0 (server-side PDFs)

```tsx
import { Document, Page, Text, View, StyleSheet, renderToBuffer, renderToStream, Font } from "@react-pdf/renderer";
const buffer = await renderToBuffer(<MyDoc {...props} />); // Node Buffer — save via storage adapter
const stream = await renderToStream(<MyDoc/>);             // Node stream — pipe into Response
```
Runs in Node route handlers / server actions (NOT edge). Add `serverExternalPackages: ["@react-pdf/renderer"]` to next.config to avoid bundling issues (recommended; standard practice — UNVERIFIED whether strictly required in 16.4). Register fonts with `Font.register({ family, src })` if non-default fonts needed.

## 7. pg-boss 12 (queues + scheduled jobs)

```ts
import PgBoss from "pg-boss";
const boss = new PgBoss(process.env.DATABASE_URL!); // or options object; schema default "pgboss"
boss.on("error", console.error);
await boss.start();
await boss.createQueue("sms");            // REQUIRED: sends to a non-existent queue fail "Queue <name> does not exist"
const id = await boss.send("sms", { to, body }, { retryLimit: 3, retryBackoff: true });
await boss.work("sms", { batchSize: 1, pollingIntervalSeconds: 2 }, async ([job]) => { /* handler gets an ARRAY of jobs */ });
await boss.schedule("daily-alerts", "0 6 * * *", {}, { tz: "Africa/Lagos" }); // tz option; default UTC; `key` option for multiple schedules per queue
```
- createQueue options: `policy` ("standard" default | "short" | "singleton" | "stately" | "exclusive" | "key_strict_fifo"), `retryLimit` (default 2), `retryDelay`, `retryBackoff`, `expireInSeconds` (default 15 min), `retentionSeconds` (default 14 d), `deadLetter` (queue name), `partition`.
- send options: `priority`, `id` (uuid — idempotency), `startAfter`, `singletonKey`, `singletonSeconds`, retry overrides.
- Worker job fields: `id, name, data, retryCount, signal (AbortSignal)`. `offWork(name)` to stop.
- Worker process pattern: separate entry (`worker/index.ts`) run via `tsx`, same DATABASE_URL, `createQueue` all queues at boot (idempotent), register `work()` handlers, `schedule()` crons; catch startup errors and `process.exit(1)`.

## 8. Drizzle ORM 0.45 + drizzle-kit 0.31

- Driver: `import { drizzle } from "drizzle-orm/node-postgres"; import { Pool } from "pg"; const db = drizzle({ client: new Pool({ connectionString }) , schema });`
- Commands: `npx drizzle-kit generate` (SQL from schema diff), `npx drizzle-kit migrate` (apply), `npx drizzle-kit push` (dev-only direct). Config `drizzle.config.ts`: `{ dialect: "postgresql", schema: "./src/db/schema/*", out: "./drizzle", dbCredentials: { url } }`.
- Transactions + row locks:
```ts
await db.transaction(async (tx) => {
  const rows = await tx.select().from(lots).where(eq(lots.id, id)).for("update"); // SELECT ... FOR UPDATE
  // ... checks, then tx.insert(stockMovements).values(...)
});
```
`.for("update")` on select builders — verify in installed types (UNVERIFIED exact builder name in 0.45, historically `.for('update')`).
- Money: `integer`/`bigint` columns (kobo). Weights: `numeric(12,3)` — comes back as string; wrap with helpers.

## 9. Dexie 4 (offline queue)

```ts
import Dexie, { type EntityTable } from "dexie";
const db = new Dexie("aggretrack-offline") as Dexie & { pending: EntityTable<PendingRecord, "id"> };
db.version(1).stores({ pending: "id, type, createdAt, status" }); // id = client-generated UUID
// React: import { useLiveQuery } from "dexie-react-hooks"; const items = useLiveQuery(() => db.pending.toArray());
```

## 10. Next.js 16.4

- Turbopack default for dev AND build; `next build --webpack` opts out (needed if Serwist webpack plugin path is chosen).
- `typedRoutes: true` top-level config (no longer experimental). `serverExternalPackages: [...]` top-level.
- Server Actions enabled by default ("use server"). Route handlers: `app/**/route.ts`. Raw body in route handler: `await req.text()` (needed for Paystack signature).
- Node.js runtime is the default — do NOT add `export const runtime = 'edge'` anywhere (PDFs, pg, crypto need Node).
- `proxy.ts` (Next 16 rename of middleware with Node runtime) — Better Auth docs show both; cookie-presence check only in proxy, real session checks in layouts/actions.

## 11. UI libs

- shadcn CLI: `pnpm dlx shadcn@latest init`, `pnpm dlx shadcn@latest add button card table dialog form input select sheet badge tabs sonner ...` (Tailwind v4 compatible).
- TanStack Table: see §0 warning (v9 latest vs v8 docs).
- Recharts 3.x: `<ResponsiveContainer><LineChart data={...}>` — standard API.

## Adapter pattern reminder (spec)

Each adapter in `src/adapters/<name>/` exports an interface + `mock.ts` + `real.ts`, chosen by env (`SMS_DRIVER=mock|termii`, etc.). Mock OTP is always `123456`; app must **refuse to start** in production with mock auth (check in a boot-time env assertion: `NODE_ENV==="production" && AUTH_OTP_DRIVER==="mock"` → throw).
