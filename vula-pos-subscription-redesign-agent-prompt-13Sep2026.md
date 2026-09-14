# Vula POS Subscription Model Redesign — AI Agent Implementation Brief

## Objective

Redesign the Vula POS subscription and plan model while the platform is still in development.

Do **not** preserve the old pricing model for backwards compatibility unless existing code requires a short transitional migration step.

The new commercial model should be simple:

```text
Monthly recurring fee
=
Licensed POS terminals × price per terminal

+

Once-off onboarding / deployment fee
```

Example:

```text
R500 per licensed terminal per month
+
R10,000 once-off onboarding
```

The plan determines features and capacity.
The subscription determines what the customer has actually purchased.
Billing uses the licensed terminal quantity.

---

# 1. Important Existing Context

Before changing code, inspect the current implementation.

Pay particular attention to:

```text
src/config/registryDb.ts
src/routes/companies.ts
src/services/billing.ts
src/services/subscriptions.ts
frontend/src/pages/PlansPage.tsx
frontend/src/types.ts
```

Also inspect existing plan, company, billing, licence, migration and enforcement tests.

This is an existing application.

Do not unnecessarily rewrite unrelated parts of the Control Plane.

Preserve:

- company/client records
- existing feature entitlement logic
- store limits
- terminal enforcement
- licence signing
- Coolify provisioning
- Head Office provisioning
- invoices
- subscription state
- client-first onboarding direction

---

# 2. Product Model

The commercial architecture should have three distinct concepts.

## Plan

Defines:

```text
features
maximum stores
maximum licensed terminals per store
whether multi-store is allowed
whether Head Office is allowed
terminal price
once-off onboarding price
billing cycle
```

## Subscription

Defines what the customer actually purchased.

Example:

```text
Company: Urban Threads
Plan: Business
Licensed terminals: 4
```

## Billing

Calculates:

```text
4 licensed terminals × R500
= R2,000/month
```

and separately:

```text
R10,000 onboarding
```

---

# 3. Recommended Commercial Plans

Use the following primary commercial model.

## Business

Target:

```text
Single-store businesses
```

Recommended defaults:

```text
Maximum stores: 1
Maximum licensed terminals per store: 10

Price per licensed terminal:
R500/month

Once-off onboarding:
R10,000
```

Features may include:

```text
Core POS
Inventory
Products
Customers
Customer credit
Suppliers
Purchasing
Advanced reports
Gross profit / margin
User roles
Audit
E-commerce bridges
Offline operation
Receipt printing
```

---

## Multi-Store

Target:

```text
Businesses operating multiple branches
```

Recommended defaults:

```text
Multiple stores
Head Office included

Price per licensed terminal:
R500/month

Once-off onboarding:
R10,000 or configurable
```

Features:

```text
Everything in Business
Head Office
Group reporting
Monthly turnover
Gross profit
Branch comparison
Central product management
Inter-branch stock transfers
Cross-store stock lookup
Central configuration
```

Head Office is **not** a billable terminal.

---

## Enterprise

Target:

```text
Large groups
Franchises
Custom deployments
```

Use:

```text
Custom pricing
Custom store limits
Custom terminal limits
Custom integrations
Custom SLA
Dedicated infrastructure if required
```

Do not force Enterprise into the standard terminal calculator if commercial pricing is negotiated.

---

# 4. Starter Plan

Starter is optional.

Do not design the whole architecture around having four plans.

If Starter is retained, keep the same per-terminal billing model with tighter feature/terminal limits.

Example:

```text
Starter

1 store
Maximum 2 terminals
R500/terminal/month
R10,000 onboarding
Reduced feature set
```

The core billing architecture must remain the same.

---

# 5. Remove the Old Bundled Pricing Model

The current development UI/model may include concepts such as:

```text
base price
included tills
extra till price
```

Remove these as the primary pricing model.

Do not model:

```text
R499 includes 15 tills,
then R299 per additional till
```

unless a future commercial requirement explicitly calls for this.

The Vula default model should be:

```text
each licensed terminal has a recurring price
```

---

# 6. Clean Plan Schema

Redesign the `plans` schema.

Recommended shape:

```text
plans
──────────────────────────────
id
code
name

pricing_mode
terminal_price_cents
setup_fee_cents
billing_period

max_stores
max_terminals_per_store

features_json

is_active
sort_order

created_at
updated_at
```

Recommended `pricing_mode` values:

```text
per_terminal
custom
```

Do not build an overly generic pricing engine yet.

If a flat pricing mode already exists and is easy to keep, it may remain, but it is not required for the main Vula model.

---

# 7. Example Business Plan Record

```json
{
  "code": "business",
  "name": "Business",
  "pricingMode": "per_terminal",
  "terminalPriceCents": 50000,
  "setupFeeCents": 1000000,
  "billingPeriod": "monthly",
  "maxStores": 1,
  "maxTerminalsPerStore": 10,
  "features": [
    "customer_credit",
    "advanced_reports",
    "ecommerce"
  ]
}
```

---

# 8. Example Multi-Store Plan Record

```json
{
  "code": "multi-store",
  "name": "Multi-Store",
  "pricingMode": "per_terminal",
  "terminalPriceCents": 50000,
  "setupFeeCents": 1000000,
  "billingPeriod": "monthly",
  "maxStores": 20,
  "maxTerminalsPerStore": 10,
  "features": [
    "customer_credit",
    "advanced_reports",
    "multi_store",
    "head_office",
    "stock_transfers",
    "ecommerce"
  ]
}
```

---

# 9. Subscription Schema

The customer subscription must contain the purchased quantity.

Recommended shape:

```text
company_subscriptions
────────────────────────────
id
company_id
plan_id

licensed_terminal_count

status

current_period_start
current_period_end

setup_fee_status

created_at
updated_at
```

Example:

```text
Urban Threads
Plan: Business
Licensed terminals: 4
```

Billing:

```text
4 × R500
= R2,000/month
```

---

# 10. Multi-Store Terminal Allocation

For Multi-Store customers, allow terminal licences to be allocated to stores.

Recommended model:

```text
store_terminal_licences
────────────────────────────
id
subscription_id
store_id
licensed_terminal_count
```

Example:

```text
Company total licences: 9

Cape Town       3
Durban          2
Johannesburg    4

Allocated       9 / 9
```

Enforce:

```text
sum(store allocations)
<=
company licensed_terminal_count
```

Also enforce:

```text
store allocation
<=
plan.max_terminals_per_store
```

---

# 11. Keep Terminal Concepts Separate

These concepts must remain distinct.

## Licensed terminals

```text
Commercial quantity
Customer pays for these
```

## Configured terminals

```text
Terminal slots configured in the POS
```

## Claimed terminals

```text
Actual device/browser bindings
```

## Open tills

```text
Currently active trading sessions
```

Example:

```text
Licensed:     3
Configured:   3
Claimed:      2
Open:         1
```

Monthly billing:

```text
3 × terminal price
```

Do not bill based on device state.

---

# 12. Billing Rule

Create one canonical recurring subscription calculator.

Example:

```ts
calculateRecurringSubscriptionAmount(company, plan)
```

For `per_terminal`:

```text
licensed_terminal_count
×
terminal_price_cents
```

Example:

```text
5 × R500
= R2,500/month
```

Do not calculate recurring fees from:

```text
device_bindings
claimed devices
online terminals
open till sessions
heartbeats
configured terminal count
```

---

# 13. Setup / Onboarding Fee

The onboarding fee is a separate one-time commercial charge.

Example:

```text
setup_fee_cents = 1000000
```

Meaning:

```text
R10,000 once-off
```

Do not include the setup fee in recurring renewal invoices.

Track whether the onboarding charge has been:

```text
not invoiced
invoiced
paid
waived
```

A simple status enum is sufficient.

---

# 14. Possible Future Multi-Store Onboarding

Prepare the architecture so a future additional-store onboarding fee can be added.

Possible future pricing:

```text
Base onboarding:
R10,000

Additional branch:
R2,500 once-off
```

Do not implement this unless it is straightforward.

The immediate redesign should focus on:

```text
setup_fee_cents
terminal_price_cents
licensed_terminal_count
```

---

# 15. Plan Editor Redesign

Refactor the current Plan modal.

Remove:

```text
Base price
Included tills
Extra till
```

Replace with:

```text
PLAN

Plan code
[ business ]

Plan name
[ Business ]


CAPACITY

Maximum stores
[ 1 ]

Maximum licensed terminals per store
[ 10 ]


PRICING

Pricing mode
[ Per licensed terminal ]

Price per licensed terminal
R [ 500.00 ]

Billing cycle
[ Monthly ]

Once-off onboarding
R [ 10,000.00 ]


FEATURES

[ ] Customer credit
[ ] Advanced reports
[ ] Multi-store / Head Office
[ ] Inter-branch stock transfers
[ ] E-commerce bridges
[ ] AI assistant
```

---

# 16. Rename "Tills per store"

Replace:

```text
Tills per store
```

with:

```text
Max licensed terminals per store
```

This is an entitlement limit.

It is not the same as:

```text
configured tills
claimed devices
open till sessions
```

---

# 17. Plan Code

Plan code must be immutable after creation.

Example:

```text
business
multi-store
enterprise
```

In edit mode:

```text
Plan code
business
(read-only)
```

Backend update routes must reject code changes.

---

# 18. Plan List Display

Show pricing clearly.

For Business:

```text
Business

R500 / terminal / month
Setup R10,000
1 store
Max 10 terminals/store
```

For Multi-Store:

```text
Multi-Store

R500 / terminal / month
Setup R10,000
Multiple stores
Head Office
```

For Enterprise:

```text
Enterprise

Custom pricing
Custom limits
```

---

# 19. Client Subscription UI

When creating or editing a client subscription:

```text
Plan
[ Business ]

Licensed terminals
[ 4 ]
```

Display a live quote:

```text
Recurring

4 × R500
= R2,000/month

Onboarding

R10,000 once-off
```

---

# 20. Multi-Store Subscription UI

For Multi-Store:

```text
Plan
Multi-Store

Licensed terminals
9
```

Allocation:

```text
Cape Town
[3]

Durban
[2]

Johannesburg
[4]

Total allocated
9 / 9
```

Display:

```text
Monthly recurring
9 × R500
= R4,500/month
```

---

# 21. Single Store to Multi-Store Upgrade

The subscription model must support the client-first workflow.

Existing:

```text
Urban Threads

Business
Cape Town
3 licences
```

Customer adds Durban.

Workflow:

```text
Add Store
    ↓
Business → Multi-Store
    ↓
Deploy Head Office
    ↓
Keep Cape Town intact
    ↓
Deploy Durban
    ↓
Allocate licences
```

Example after upgrade:

```text
Cape Town       3
Durban          2

Total           5

Monthly
5 × R500
= R2,500
```

Do not rebuild or migrate the existing store database merely because the customer becomes Multi-Store.

---

# 22. Head Office

Head Office is a capability of the Multi-Store plan.

It is not:

```text
a billable terminal
```

It should be automatically provisioned by the Control Plane when a client transitions from single-store to Multi-Store.

The Control Plane should explicitly configure the client's Head Office URL.

Do not derive Head Office URLs from hostname conventions.

---

# 23. Licence Generation

Update licence generation so the store receives its terminal allowance.

Example:

```json
{
  "plan": "business",
  "maxTerminals": 4
}
```

For Multi-Store, each store receives its allocation.

Example:

```text
Cape Town licence:
maxTerminals = 3

Durban licence:
maxTerminals = 2
```

The company subscription remains the commercial source of truth.

---

# 24. POS Enforcement

The POS must prevent additional terminal claims when the licensed terminal limit is reached.

Do not use:

```text
currently online device count
```

as the licence quantity.

Use the signed licence entitlement.

The POS must continue functioning offline according to the existing offline lease/licence model.

---

# 25. Invoices

Recurring invoice calculation should use:

```text
licensed terminal quantity
×
terminal rate
```

Example:

```text
4 licensed terminals @ R500
R2,000
```

The onboarding invoice should be separate.

Example:

```text
Vula onboarding and deployment
R10,000
```

Initial invoice may contain both if desired:

```text
Onboarding                         R10,000
4 terminal licences @ R500         R2,000
                                  --------
Subtotal                           R12,000
```

VAT handling remains separate according to existing invoicing rules.

---

# 26. Renewal

Recurring renewal invoices must contain only recurring charges.

Do not repeat:

```text
setup fee
```

on every renewal.

Renewal example:

```text
4 terminal licences @ R500
R2,000
```

---

# 27. Automated Payment Warning

Inspect the existing billing service.

If the current code automatically creates a synthetic payment and marks invoices paid without confirmation from a real settlement source, do not extend this behaviour.

Preferred model:

```text
Invoice generated
        ↓
Pending payment
        ↓
Payment confirmed
        ↓
Invoice paid
```

If current development code requires temporary manual behaviour, isolate it clearly and document it as technical debt.

---

# 28. Development Reset

The application is still in development.

Therefore:

- do not preserve obsolete pricing abstractions unnecessarily
- remove obsolete schema fields if no longer required
- update development seeds
- update APIs
- update UI
- update billing
- update licences
- update tests

A clean breaking migration/reset is acceptable if needed.

Do not introduce compatibility complexity solely for unused development data.

---

# 29. Recommended Fresh Seed Plans

For fresh development databases:

## Business

```text
code:
business

pricing:
R500 / licensed terminal / month

setup:
R10,000

max stores:
1

max terminals/store:
10
```

Feature defaults should reflect the current product.

---

## Multi-Store

```text
code:
multi-store

pricing:
R500 / licensed terminal / month

setup:
R10,000

max stores:
20

max terminals/store:
10

Head Office:
enabled

Stock transfers:
enabled
```

---

## Enterprise

```text
code:
enterprise

pricing:
custom

limits:
custom
```

---

# 30. API Contract

Recommended Plan response:

```json
{
  "id": 1,
  "code": "business",
  "name": "Business",
  "pricingMode": "per_terminal",
  "terminalPriceCents": 50000,
  "setupFeeCents": 1000000,
  "billingPeriod": "monthly",
  "maxStores": 1,
  "maxTerminalsPerStore": 10,
  "features": [],
  "isActive": true
}
```

Recommended subscription response:

```json
{
  "companyId": "cmp_123",
  "planCode": "business",
  "licensedTerminalCount": 4,
  "recurringAmountCents": 200000,
  "setupFeeStatus": "paid"
}
```

---

# 31. Validation

All money values must be stored as integer cents.

Do not use floating-point currency internally.

Validate:

```text
terminal_price_cents >= 0
setup_fee_cents >= 0
licensed_terminal_count >= 0
max_stores >= 1
max_terminals_per_store >= 1
```

For:

```text
pricing_mode = per_terminal
```

require:

```text
terminal_price_cents > 0
```

---

# 32. Control Plane Client-First Direction

Keep this aligned with the Control Plane redesign.

Primary workflows:

```text
New Client
Add Store
Manage Client
```

The operator should not need to manually manage disconnected:

```text
Companies
Stores
Head Offices
Tokens
Licences
Coolify resources
```

during normal onboarding.

The Control Plane should orchestrate these behind the client workflow.

---

# 33. New Client — Business Example

Example onboarding:

```text
Client
Urban Threads

Deployment
Single Store

Plan
Business

Store
Cape Town

Licensed terminals
3
```

Live commercial summary:

```text
Monthly
3 × R500
= R1,500

Once-off onboarding
R10,000
```

---

# 34. New Client — Multi-Store Example

```text
Client
ABC Retail

Deployment
Multi-Store

Plan
Multi-Store

Cape Town
3 licences

Durban
2 licences

Johannesburg
4 licences
```

Summary:

```text
Total licensed terminals
9

Recurring
9 × R500
= R4,500/month

Onboarding
R10,000

Head Office
Included
```

---

# 35. Do Not Mix Vendor Control Plane and Client Business Data

This pricing redesign must not weaken the privacy model.

The Vula Developer Control Plane may know:

```text
plan
subscription status
licensed terminal quantity
setup fee status
invoice status
store count
licence state
```

It should not need:

```text
customer sales
merchant turnover
merchant gross profit
transaction contents
customer records
stock values
```

Those belong in client-facing Store Office / Head Office.

---

# 36. Tests Required

Add/update tests for at least:

1. Create Business plan.
2. Create Multi-Store plan.
3. Plan code cannot change.
4. Terminal price stored in cents.
5. Setup fee stored in cents.
6. 1 licence × R500 = R500.
7. 3 licences × R500 = R1,500.
8. 9 licences × R500 = R4,500.
9. Setup fee does not appear on renewal.
10. Subscription quantity is independent of claimed terminals.
11. Subscription quantity is independent of open tills.
12. Store allocations cannot exceed company licence count.
13. Store allocations cannot exceed max terminals/store.
14. Business cannot exceed max store count.
15. Multi-Store enables Head Office.
16. Existing licence signing/enforcement remains functional.
17. Offline licence behaviour remains functional.
18. Invoice generation uses licensed terminal quantity.
19. Enterprise custom pricing does not accidentally auto-calculate.
20. Currency calculations remain integer based.

---

# 37. Implementation Order

Before coding, inspect the existing code and produce a short implementation plan.

Then implement in this order.

## Phase 1 — Schema

- redesign plan fields
- add subscription licensed terminal quantity
- add store allocations if required
- update development seeds

## Phase 2 — Domain Services

Create canonical services for:

```text
subscription pricing
terminal allocation validation
setup fee state
```

## Phase 3 — Billing

Update:

```text
invoice generation
renewal amount
quote calculation
```

## Phase 4 — Licence

Update licence generation and terminal allowance enforcement.

## Phase 5 — APIs

Update Plan, Company and Subscription APIs.

## Phase 6 — Plans UI

Redesign plan create/edit screens.

## Phase 7 — Client Subscription UI

Add licensed terminal quantity and live pricing.

## Phase 8 — Multi-Store Allocation

Implement per-store allocation.

## Phase 9 — Tests

Run all relevant existing and new tests.

---

# 38. Definition of Done

The redesign is complete when the following works cleanly.

Create:

```text
Business

R500 / licensed terminal / month
R10,000 setup
1 store
Max 10 terminals
```

Assign:

```text
Urban Threads
Business
4 licensed terminals
```

Control Plane displays:

```text
Monthly recurring
R2,000

Once-off onboarding
R10,000
```

Licence permits:

```text
4 terminals
```

Billing generates:

```text
4 × R500
```

Renewal does not include setup again.

Claiming/unclaiming devices does not change the subscription amount.

---

For Multi-Store:

```text
ABC Retail

Multi-Store
9 licensed terminals

Cape Town      3
Durban         2
Johannesburg   4
```

Control Plane displays:

```text
Monthly recurring
R4,500

Head Office
Included
```

and each branch receives the correct licensed terminal entitlement.

---

# 39. Final Agent Instructions

Do not make unrelated architectural changes.

Do not commit or deploy unless explicitly requested.

At completion, report:

1. files changed
2. schema changes
3. removed legacy pricing fields
4. API changes
5. billing changes
6. licence changes
7. UI changes
8. tests added/updated
9. test results
10. any remaining billing or subscription technical debt
