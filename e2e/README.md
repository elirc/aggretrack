# AggreTrack e2e (Playwright)

Specs run against a dev server on **port 3100** bound to the dedicated
`aggretrack_e2e` database (see `playwright.config.ts`: mock SMS/email/payments,
`BETTER_AUTH_URL=http://localhost:3100`, 360x740 mobile viewport, 1 worker).

## Run

1. Seed the e2e database (fresh, from the P5-A seed):

   ```bash
   DATABASE_URL=postgres://postgres:postgres@localhost:5432/aggretrack_e2e pnpm exec tsx scripts/seed.ts --reset
   ```

2. Run the suite (Playwright starts `pnpm dev --port 3100` itself, or reuses one already on 3100):

   ```bash
   pnpm test:e2e
   ```

   A single file: `pnpm test:e2e e2e/dod-flow.spec.ts`.

## Specs

| File | What it proves |
| --- | --- |
| `auth.spec.ts` | Phone OTP login (mock code `123456`) lands on the dashboard; email login (manager); a wrong OTP shows an error |
| `dod-flow.spec.ts` | The SPEC "Definition of done" flow as one serial chain: purchase → receive (GRN, stock rises, lot listed) → sale → FIFO allocate → dispatch (waybill) → delivery 4,990 kg (transit loss) → invoice → full payment (paid) → margin report → lot trace (supplier + customer) |
| `roles.spec.ts` | Warehouse keeper with "Hide prices" ON sees no `₦` on /stock and no selling/payables nav, but can open /dispatches; procurement only sees allowed buying points and no selling nav |
| `offline.spec.ts` | Purchase queued with the context offline, synced when back online, listed exactly once |

## Seed contract the specs rely on

- Org **Gombe AgriTrade**; password `demo1234` for every role.
- Emails `owner|manager|procurement|warehouse|sales|accountant@demo.aggretrack.local`; phones `2348000000001..6` in that order.
- Commodity **Maize** with grade **Grade A**; warehouse **Gombe Main**; at least one vehicle and one driver; suppliers and customers.
- Procurement is restricted to a subset of the buying points (the org has more than one); the warehouse keeper is restricted to Gombe Main.
- `hide_prices_from_warehouse` is OFF by default. `roles.spec.ts` switches it ON through the owner's /settings page and switches it back OFF in `afterAll`.

## Notes

- Specs create data (a purchase, a sale, a payment), so **re-seed with `--reset` before each full run**.
- Better Auth limits `/phone-number/send-otp` to 3 per 10 minutes. `auth.spec.ts` sends 2, so running it twice within 10 minutes hits 429. Re-seed or wait. `loginAs` backs off and retries on the sign-in limiter.
- The first visit to each route compiles under `next dev`. Navigation timeouts are 90 s and heavy tests allow 180 s.
