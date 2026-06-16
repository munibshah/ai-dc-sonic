# AIDC booking backend (Cloudflare Worker + D1)

Serverless backend for lab-slot reservations and instructor-led training signups.
Runs at `book.<domain>`, fronted by Cloudflare Access (which supplies learner
identity). It is intentionally **separate** from the lab orchestrator — booking,
identity, and scheduling are orthogonal to the lab-state machine.

## One-time setup

```bash
cd booking
npm install

# 1. Create the D1 database, paste the returned id into wrangler.jsonc.
npx wrangler d1 create aidc-booking

# 2. Create the schema (remote = production DB).
npm run schema:remote

# 3. Set the shared secret the orchestrator uses for /api/holder/current.
#    Must equal the orchestrator's AIDC_BOOKING_SECRET env var.
npx wrangler secret put ORCH_SHARED_SECRET

# 4. Fill ACCESS_TEAM_DOMAIN + ACCESS_AUD in wrangler.jsonc from the Access
#    application you create for book.<domain> (Zero Trust -> Access -> Apps).

# 5. Deploy.
npm run deploy
```

Put the Worker behind a custom domain `book.<domain>` and protect it with a
Cloudflare Access policy (email OTP / Google). Add a second Access policy scoped
to the instructor email for the `/api/admin/*` paths.

## Instructor operations

```bash
# Seed available 60-minute slots (5 of them, starting at a time):
curl -X POST https://book.<domain>/api/admin/slots \
  -H 'content-type: application/json' \
  -d '{"starts_at":"2026-06-20T14:00:00Z","slot_minutes":60,"count":5}'

# Announce the next training session:
curl -X POST https://book.<domain>/api/admin/training \
  -H 'content-type: application/json' \
  -d '{"title":"SONiC fabric deep-dive","starts_at":"2026-06-25T16:00:00Z","capacity":12,"location":"https://meet.example/aidc"}'

# Read the roster:
npx wrangler d1 execute aidc-booking --remote \
  --command "SELECT s.title, g.email, g.name FROM training_signups g JOIN training_sessions s ON s.id = g.session_id"
```

(Admin curls only work from a browser/session authenticated as the instructor
through Access; for scripting, use `wrangler d1 execute` directly.)

## Local dev (no Access)

`cp .dev.vars.example .dev.vars`, then `npm run dev`. With `ACCESS_AUD` left at
its placeholder, JWT verification is skipped and identity falls back to a
`?dev_email=you@example.com` query param — **dev only**.

## Paid-ready seam

`slots.payment_status` exists (`free` today) but no Stripe is wired. To add paid
slots later: gate `bookSlot` on a Stripe Checkout session, flip `payment_status`
to `paid` on the webhook, and only count `paid` (or `free`) slots as held.
