I reviewed the attached **Vula Control Plane** as the root-of-trust service for the whole POS platform. Architecturally it is in a good place, but there are several issues I would treat as **production blockers**, mainly around billing → entitlement transitions, licence refresh, deletion/audit integrity, and outbound credential handling.

The most important point is this: **the Control Plane is more security-sensitive than an individual POS store**. A defect here can affect every customer, every store, terminal licensing and Head Office access.

## Overall assessment

I would rate the current state conceptually like this:

| Area                         | Assessment                        |
| ---------------------------- | --------------------------------- |
| Overall architecture         | Strong                            |
| Store/Head Office separation | Good                              |
| Licence signing model        | Strong                            |
| Billing data model           | Good foundation                   |
| Billing settlement logic     | **Needs urgent correction**       |
| Subscription enforcement     | **Needs urgent correction**       |
| Licence delivery/recovery    | **Incomplete**                    |
| Control Plane authentication | Needs hardening                   |
| Auditability                 | Good start, gaps remain           |
| Deployment orchestration     | Good foundation, needs durability |
| API validation               | Inconsistent                      |
| Secrets management           | Needs improvement                 |
| Database migrations          | Becoming difficult to maintain    |
| Automated backend testing    | Good                              |
| Frontend testing             | Missing                           |

---

# 1. Critical: paying almost any invoice can extend the subscription

This is the most serious issue I found.

In:

```text
src/services/billing.ts
processPaymentAndRenew()
```

the flow effectively does:

```text
invoice
  ↓
record payment
  ↓
mark invoice paid
  ↓
calculate next paid_through
  ↓
company becomes active
  ↓
push new licences
```

The problem is that this happens regardless of **what the invoice represents**.

So an invoice could be:

```text
Setup fee
R2,500
```

or:

```text
Special support charge
R500
```

and paying it can advance the company's subscription.

That's not what you want.

### More serious: partial payment isn't properly checked

The endpoint accepts:

```ts
amountCents
```

and defaults to invoice value if omitted.

But I found no requirement that:

```ts
amountCents === invoice.amount_cents
```

or even:

```ts
amountCents > 0
```

So conceptually this can happen:

```text
Subscription invoice     R5,000
Payment entered           R1
                         ↓
Invoice marked paid
                         ↓
Subscription extended
                         ↓
New licences issued
```

A zero or potentially negative integer also isn't adequately rejected at this layer.

### I would change the invoice model

Every invoice should have an explicit purpose:

```ts
type InvoicePurpose =
  | 'initial_subscription'
  | 'renewal'
  | 'prorata'
  | 'onboarding'
  | 'hardware'
  | 'support'
  | 'manual';
```

And preferably:

```text
service_period_start
service_period_end
```

Then:

```text
initial_subscription → may activate/extend entitlement
renewal              → may extend entitlement

prorata               → usually does NOT blindly add another period
onboarding            → does NOT extend subscription
hardware              → does NOT extend subscription
manual                → does NOT extend subscription
```

I would make this a **P0 fix**.

---

# 2. Critical: an expired trial can become active

The current subscription-state derivation has a dangerous edge case.

The logic in `src/services/subscriptions.ts` roughly reaches:

```ts
if (!paidThrough) {
    return 'active';
}
```

after trial handling.

That means:

```text
Trial ends:
31 August 2026

Today:
23 September 2026

paid_through:
NULL
```

can end up as:

```text
ACTIVE
```

rather than expired/suspended.

A company that has **never paid and has no trial** can also fall into the active state.

For a subscription-controlled POS this defeats the licensing model.

### I'd use explicit states

Something closer to:

```text
pending_activation
trial
active
past_due
suspended
cancelled
```

Logic:

```ts
if (manuallySuspended)
    return 'suspended';

if (paidThrough)
    return deriveFromPaidPeriod();

if (trialEndsAt)
    return now <= trialEndsAt
        ? 'trial'
        : 'suspended';

return 'pending_activation';
```

This should be fixed alongside billing before production subscription enforcement is trusted.

---

# 3. Critical: licences are not automatically refreshed/retried

This was surprising because your design documentation suggests they are.

Your licence architecture itself is good:

```text
Control Plane
    │
    ├── ECDSA P-256 private key
    │
    ↓
signed licence
    │
    ↓
Store/Head Office
    │
    └── verifies using public key
```

That's the right pattern.

But the normal health sweep currently does approximately:

```text
ping store
collect telemetry
```

It does **not** automatically do:

```text
refresh/retry licence
```

The manual store health route does attempt a licence push, but the scheduled sweep doesn't.

That's important because your licence contains an offline expiry such as:

```text
maxOfflineUntil = now + 14 days
```

Suppose a customer pays for a month.

```text
1 Sep
Licence issued
maxOfflineUntil = 15 Sep

Subscription paid through = 30 Sep
```

If nothing causes another licence issuance by 15 September, a perfectly paid-up store can eventually fail offline licence checks.

Likewise, if a licence push fails when billing changes:

```text
Push failed
```

your docs imply:

> next sweep retries

but the implementation currently doesn't do that.

### I would make the health scheduler responsible for recovery

For each store:

```text
Health sweep
     │
     ├─ authenticated health check
     │
     ├─ collect licence sequence
     │
     ├─ compare desired entitlement
     │
     └─ refresh licence when:
          - previous push failed
          - licence nearing offline expiry
          - entitlement changed
          - licence sequence behind
```

You don't need a new signed licence every ten minutes.

For example refresh when:

```text
< 7 days of offline validity remaining
```

or after any entitlement change.

This is another **P0** item for me.

---

# 4. Company deletion can destroy billing history

This is an important audit/accounting issue.

Company deletion currently checks mainly for:

```text
stores
head-office panels
```

as blockers.

But some financial tables use foreign keys resembling:

```text
company_id ... ON DELETE CASCADE
```

including invoices/payments.

That means if a company has no stores anymore but has historical invoices/payments, deleting it can remove those records.

For a billing system I would **never hard-delete a company once financial documents exist**.

Use:

```text
active
archived
cancelled
```

and retain:

```text
company
invoices
payments
subscription history
licence events
audit events
```

indefinitely according to your data-retention policy.

A duplicate company that never transacted can perhaps be hard-deleted.

Once an invoice exists:

> archive, don't delete.

---

# 5. There is a subtle NULL-clearing bug in company updates

This one is easy to miss.

In `registryDb.ts`, company updates use patterns such as:

```sql
plan_id =
    COALESCE(?, plan_id),

paid_through =
    COALESCE(?, paid_through),

trial_ends_at =
    COALESCE(?, trial_ends_at)
```

But your API allows `null` to mean:

> clear this field.

SQL `COALESCE` means the opposite:

```text
new value = NULL
       ↓
use old value
```

So:

```json
{
  "trialEndsAt": null
}
```

doesn't actually clear `trial_ends_at`.

Likewise potentially:

```text
planId
paidThrough
trialEndsAt
```

This can create very confusing subscription behaviour.

Use dynamic updates or explicit presence flags.

For example:

```ts
if ('trialEndsAt' in patch) {
    updates.push('trial_ends_at = ?');
    args.push(patch.trialEndsAt);
}
```

Then `undefined` means:

> unchanged

while `null` actually means:

> NULL.

---

# 6. Multi-step billing updates aren't sufficiently transactional

A payment involves several pieces of business state:

```text
payment
invoice
setup-fee state
company subscription state
```

These should be one SQLite transaction.

Currently too much of the process is separate calls.

Consider a crash:

```text
Payment inserted
       ↓
Invoice marked paid
       ↓
PROCESS CRASHES
       ↓
paid_through not updated
```

or the inverse depending on the failure point.

I'd make:

```text
BEGIN

record payment
update invoice
update billing status
update company paid_through
write audit event

COMMIT
```

Then outside the transaction:

```text
push licence
send email
other network operations
```

Network failure should **never roll back financial truth**.

Instead record:

```text
licence_delivery_status = failed
```

and retry independently.

---

# 7. Client editing has similar partial-update risk

I found the same general issue in company/client management.

A request can:

1. update company fields;
2. update purchased terminal quantity;
3. validate allocations;
4. discover that allocation is invalid;
5. return an error.

But steps 1–2 may already have committed.

User sees:

```text
Update failed
```

but some state changed.

For Control Plane actions that represent one logical operation, use:

```ts
db.transaction(() => {
   validateEverything();
   updateCompany();
   updateSubscription();
   updateAllocations();
   writeAudit();
})();
```

Preferably validate all pure business rules **before touching the database**.

---

# 8. SSRF + token exfiltration through store URLs

This deserves high priority because the Control Plane makes privileged outbound requests.

The control plane stores:

```text
store.base_url
store.control_plane_token
```

Then effectively makes:

```text
GET {base_url}/some/internal/api
X-Control-Plane-Token: secret
```

The URL validation mostly ensures:

```text
http:// or https://
```

It doesn't adequately establish:

> this URL is genuinely the customer's Vula server.

An attacker with Control Plane access could set:

```text
http://attacker.example.com
```

as the store URL.

The next health call sends the store's Control Plane token to the attacker's server.

Or:

```text
http://169.254.169.254/
http://127.0.0.1/
http://internal-service/
```

could potentially be used as an SSRF primitive.

### For production-managed Vula deployments

I'd strongly prefer:

```text
HTTPS required
+
approved deployment domain
```

For example:

```text
*.stores.vulapos.co.za
*.customer-vula-hosting-domain...
```

If arbitrary custom domains are required, apply the same type of protections you already built into the POS remote-image fetcher:

```text
DNS resolution
private IP rejection
loopback rejection
link-local rejection
cloud metadata rejection
redirect revalidation
```

And when somebody changes a store URL:

```text
new URL
   ↓
validate
   ↓
probe /api/system/app-kind
   ↓
confirm expected Vula Store
   ↓
only then save/use token
```

Your image-fetch SSRF protection is actually stronger than the Control Plane's much more sensitive store client.

---

# 9. Panel URL updates are even less strict

The Head Office panel update route appears to allow its base URL to be changed without the same level of validation used at creation.

I'd centralize all managed endpoint handling into one helper:

```ts
validateManagedEndpoint(url, expectedKind)
```

and make it mandatory for:

```text
store create
store edit
Head Office create
Head Office edit
provisioning/import
```

Don't let individual routes implement their own version.

---

# 10. Control Plane authentication should be stronger

Currently it is essentially:

```text
one office admin identity
+
password
+
JWT
```

with a relatively long token lifetime.

For an ordinary store admin that might be tolerable initially.

For the Control Plane, this account can potentially:

```text
suspend all customers
issue licences
change subscriptions
reset store admins
reveal Head Office credentials
create deployments
alter billing
```

I'd strengthen this before production.

At minimum:

```text
Shorter access-token lifetime
MFA
named Control Plane users
roles
session revocation
audit actor = actual account
```

Roles eventually:

```text
Platform Owner
Billing Admin
Support
Deployment Operator
Read-only Support
```

A support engineer should not automatically have the ability to alter billing or issue licences.

---

# 11. JWT storage is also worth changing

The frontend currently stores the Control Plane JWT in:

```text
localStorage
```

That means any future XSS in the Control Plane can extract the fleet-level credential.

For such a privileged app I'd favour:

```text
Secure
HttpOnly
SameSite cookie
```

with CSRF protection where appropriate, or short-lived in-memory access credentials backed by a secure session/refresh mechanism.

This is less critical for your store POS than it is for the Control Plane.

---

# 12. Login rate limiting isn't deployment-aware

You have a login limiter, which is good.

But it's:

```text
in-memory
+
req.ip
```

and I didn't see deliberate Express proxy trust configuration.

Behind Coolify/Traefik this can cause either:

```text
all users appear to come from proxy IP
```

or incorrect client identification.

One bad actor could therefore potentially lock out everyone behind that apparent address.

And restarting the Control Plane resets the limiter.

Configure the exact trusted proxy topology and eventually use:

```text
account + IP
```

with persistence/shared storage.

---

# 13. Remove the development credentials hint from production UI

The login page contains the dev-default hint along the lines of:

```text
admin@za-pos.local / temp123
```

Your backend correctly rejects insecure production defaults, so this is not itself a credential vulnerability.

But it should still be:

```ts
if (import.meta.env.DEV)
```

only.

There's no reason to advertise development conventions on the production Control Plane login page.

---

# 14. Secrets are stored plaintext in the registry DB

The registry database contains sensitive values such as:

```text
store control-plane tokens
Head Office tokens
panel control-plane tokens
SMTP password
```

The service needs to retrieve some of those secrets, so you can't merely hash them.

But I would encrypt them at application level:

```text
Registry SQLite
      ↓
AES-GCM encrypted value
      ↓
master encryption key from environment/secret manager
```

The DB alone should not give an attacker every store credential.

Your licence **private key being external to the database is good**. Apply similar thinking to operational credentials.

---

# 15. I didn't find a proper Control Plane backup system

The Control Plane registry is one of the most important databases in Vula.

It contains:

```text
companies
stores
subscription state
billing
invoice numbers
payments
licensing state
deployment registry
credentials
audit data
```

Persistent `/data` is good.

But:

> persistent storage ≠ backup.

I would add:

```text
scheduled SQLite backup
       ↓
separate storage
       ↓
encrypted
       ↓
retention policy
       ↓
periodic restore test
```

The POS application already demonstrates good thinking around backups. The Control Plane deserves at least the same level.

---

# 16. Provisioning can report success too easily

Your deployment workflow is nicely structured into steps.

However the final health-validation step is largely best effort.

It can try stores, swallow failures, and still complete the deployment.

So you can potentially get:

```text
Deployment: Complete
```

while:

```text
Store A     unreachable
Store B     licence push failed
Head Office auth broken
```

I would introduce:

```text
queued
running
complete
complete_with_warnings
failed
```

and formal readiness requirements.

For example:

### Required

```text
✓ deployment created
✓ application reachable
✓ correct Vula app-kind
✓ bootstrap/admin ready
✓ configuration accepted
✓ signed licence accepted
```

### Optional/warning

```text
email notification failed
telemetry fetch delayed
non-essential metadata unavailable
```

Only the second category should allow `complete_with_warnings`.

---

# 17. Some provisioning work isn't durable

There are places where provisioning is kicked off using a background promise from the HTTP request process.

If the Control Plane restarts:

```text
request accepted
      ↓
provisioning running
      ↓
process restart
      ↓
job disappears
```

You already have a jobs concept elsewhere.

I would make **all provisioning workflows durable**:

```text
provisioning_jobs
step
state
attempt
next_retry_at
last_error
```

The web request should create the job.

A worker should execute it.

Then process restart simply resumes unfinished work.

That's particularly important once you're provisioning real paying customers.

---

# 18. Coolify calls need explicit timeouts

I didn't see sufficiently consistent network timeouts around all Coolify orchestration calls.

A network request to Coolify should never be allowed to hang the job indefinitely.

Something like:

```text
connect/read timeout
+
bounded retry
+
idempotent reconciliation
```

For example:

> Did this deployment fail to be created, or did our HTTP call time out after Coolify successfully created it?

Your workflow should be able to resolve that by looking up existing resources rather than creating duplicates.

---

# 19. Nested onboarding payload validation is too loose

Top-level fields get reasonable checking in many routes.

But nested structures such as:

```json
{
  "stores": [
    {
      "slug": "...",
      "terminalCount": 4
    }
  ],
  "headOffice": {
    ...
  }
}
```

have much weaker validation.

I found cases where these nested values are effectively trusted/cast rather than validated with the same helpers as regular store creation.

This is where I'd introduce a schema library.

For example:

```text
Zod
TypeBox
Valibot
```

Then:

```ts
const CreateClientSchema = z.object({
   company: ...,
   subscription: ...,
   stores: z.array(StoreSchema),
   headOffice: HeadOfficeSchema.optional()
});
```

You then get:

```text
integers really are integers
terminalCount >= 0
valid URL
valid slug
valid email
enum values really valid
```

before the orchestration layer sees anything.

---

# 20. Plan reductions need an explicit business rule

Suppose a customer has:

```text
10 stores
6 terminals/store
```

and you change their plan to:

```text
maxStores = 5
maxTerminalsPerStore = 3
```

What happens?

The current architecture can detect some aggregate overage situations, but the entitlement semantics aren't completely clear.

You need an explicit policy.

Either:

### Immediate enforcement

```text
Plan downgrade
     ↓
customer must resolve excess resources first
```

or:

### Grandfather current allocation

```text
Existing = retained
New allocations = blocked
```

or:

### Scheduled downgrade

```text
New limits take effect next billing cycle
```

Don't let a plan edit silently produce licences whose allocation exceeds the plan's advertised maximum.

---

# 21. Plan changes affect existing customers globally

Your invoice pricing is snapshotted, which is good.

But product/feature entitlements come from the current plan.

So editing a plan can immediately alter existing customers' capabilities.

That might be what you want, but distinguish:

```text
pricing grandfathering
```

from:

```text
feature entitlement grandfathering
```

They're different commercial decisions.

Eventually you might want:

```text
plan version
```

rather than mutating the meaning of a plan underneath all subscribers.

---

# 22. `overdue` exists but isn't really automated

The invoice model understands an:

```text
overdue
```

status, but I couldn't find a normal scheduled process that marks:

```text
pending → overdue
```

based on due date.

Similarly the function named around automated renewals currently appears exposed through a manual route rather than an actual scheduler.

So be careful about UI wording suggesting:

> automatic renewal processing

unless a recurring worker is actually running it.

I would add a small durable billing scheduler:

```text
daily
 │
 ├─ create upcoming renewal invoices
 ├─ mark overdue invoices
 ├─ update grace/past-due state
 ├─ refresh/revoke entitlements
 └─ enqueue emails
```

---

# 23. Protect simulated billing from production

You have useful development/test functionality to simulate settlement.

That's fine.

I would make production startup explicitly refuse:

```text
BILLING_SIMULATE_RENEWAL_SETTLEMENT=true
```

rather than relying on deployment discipline.

Same philosophy as your existing check that rejects default JWT/password values.

---

# 24. Head Office token “reveal” isn't truly reveal-once

For a panel you have an endpoint that can reveal its token.

It can be called repeatedly by an authenticated Control Plane user.

If you want actual reveal-once semantics, use:

```text
token_created
token_revealed_at
```

and disallow further reads.

Even better:

```text
Reveal once
Rotate
```

instead of treating the existing secret as permanently viewable.

Again, stronger Control Plane user authentication reduces the risk substantially.

---

# 25. Panel deletion should be a decommission process

Stores have some concept of pause before removal.

Head Office panels can be removed more abruptly.

I'd standardize lifecycle:

```text
Active
   ↓
Paused
   ↓
Decommissioning
   ↓
Licence revoked/shortened
   ↓
Deployment stopped
   ↓
Archived
```

Don't merely delete the registry entry while an actual deployment may still exist and hold valid credentials/licensing state.

---

# 26. Migrations have outgrown the current pattern

`src/config/registryDb.ts` is now over **100 KB**.

It contains schema definition, compatibility checks and migration work.

This is reaching the point where I'd move to:

```text
migrations/
  001_initial.sql
  002_billing.sql
  003_head_office.sql
  004_device_licensing.sql
  005_invoice_purpose.sql
  ...
```

with:

```text
schema_migrations
-----------------
version
applied_at
```

And for the Control Plane specifically:

```text
backup before migration
BEGIN
migration
foreign_key_check
COMMIT
```

Your existing migration tests are valuable; retain them.

---

# 27. Frontend test coverage is effectively absent

Your server-side test suite is extensive — roughly a couple hundred test declarations across more than twenty backend test files.

That's a real strength.

But I found effectively no automated frontend tests.

For the Control Plane I'd especially test:

```text
billing settlement confirmation
partial-payment rejection
company suspension
plan change
licence push status
token reveal
destructive actions
JWT expiry/logout
provisioning progress/retry
```

A UI bug in this system can make a high-impact API call.

---

# Things I particularly like

There is a lot here worth retaining.

The **asymmetric licence signing architecture** is exactly the direction I'd want: the private signing capability remains central, while stores only need the public verification key.

Separating the **vendor Control Plane token** from the **merchant Head Office token** is also an important architectural improvement. Don't collapse those credentials again.

Invoice amounts and rates being stored as **integer cents** is correct. Invoice pricing/rate snapshots are preferable to recomputing old invoices from today's plan.

The licence sequence reconciliation mechanism is also thoughtful: checking which sequence a deployment already has helps protect against a restored Control Plane database accidentally trying to push an older licence.

The app has meaningful production startup safeguards instead of simply starting with development secrets.

And there is substantially more automated backend testing than I'd usually see at this stage.

---

# What I would fix first

I'd do this in four focused passes:

1. **Billing/licence correctness:** fix the partial-payment/manual-invoice renewal problem, expired-trial logic, invoice purposes, transactional settlement, automatic licence refresh/retry, and make simulation impossible in production.

2. **Trust boundary hardening:** validate/allowlist deployment URLs, eliminate SSRF/token exfiltration possibilities, strengthen Control Plane authentication, configure proxy-aware rate limiting, encrypt stored service credentials.

3. **Audit/data integrity:** stop hard deletion of financially active companies, fix NULL-clearing updates, make complex company edits atomic, add Control Plane backups, standardize decommissioning.

4. **Operational reliability:** durable provisioning jobs, meaningful final deployment health checks, Coolify request timeouts/reconciliation, proper nested request schemas and frontend tests.

The two issues I would address **before adding any more Control Plane features** are:

```text
Billing payment → subscription entitlement logic
```

and:

```text
Licence refresh / failed-delivery retry
```

Those two directly determine whether Vula correctly answers the most important SaaS question:

> **Is this customer entitled to trade right now, and can their paid stores reliably receive that entitlement?**

One verification caveat: I attempted the repository's executable TypeScript/test checks, but dependency installation timed out in this environment before completing. The subsequent typecheck therefore complained about missing Node/Jest type packages from that incomplete install; I don't consider that evidence of a source-build failure. The findings above come from tracing the actual source, database schema, routes, services and provisioning/licensing flows.

