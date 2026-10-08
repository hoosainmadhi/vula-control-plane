# Deploy Vula stores + the Control Plane on Coolify (OCI)

Two kinds of workload, both private-GitHub-repo Dockerfile builds on the same
Coolify (OCI) server:

- **Store apps** — the per-store Vula deployment (`~/apps/za-pos` repo, one
  container per store, one SQLite DB per store in its own volume).
- **This control plane** — `~/apps/za-pos-control-plane` repo, one container,
  registry DB in its own volume.

The control plane **does** provision Coolify when it has API credentials
(`COOLIFY_API_URL` / `COOLIFY_API_TOKEN` / `COOLIFY_PROJECT_UUID` /
`COOLIFY_SERVER_UUID` / `COOLIFY_GITHUB_APP_UUID`): the client wizard creates the
application, its persistent volume and its environment variables, triggers the
build, then health-checks the result. With any of those unset it degrades to
manual provisioning, so Parts A–B below remain the reference for what a
deployment actually needs.

For a real multi-tenant host — the shared data tree, the ownership rule, and the
checklist to close before cutover — see
`~/apps/za-pos/prompts/deploy-production-vula-app.md`.

## Prerequisites

- Coolify resource creation rights; a GitHub App covering both repos
  (`za-pos` and `za-pos-control-plane`), or public repos.
- DNS: the domain is registered (**vula-app.co.za**) and a wildcard
  `*.vula-app.co.za` → the Coolify server covers every store
  (`<slug>.vula-app.co.za`), every Head Office (`<company-slug>-ho.vula-app.co.za`)
  and this panel, which sits on the obscure hostname
  `vula-cp-mzsza-2026.vula-app.co.za` by decision. Store slug = the registry slug =
  the subdomain label.

## Part A — deploy a Vula store (repeat per store)

1. Generate the store's control-plane token (the store and this registry must
   agree on it):
   ```bash
   openssl rand -hex 32        # e.g. 5f9e…; paste into both places below
   ```
2. Coolify → **New Resource → Private Repository (GitHub)** → `za-pos` repo →
   branch `main` → **Build Pack: Dockerfile** → **Ports Exposes: 3000**.
3. Environment variables (the tenant app validates these — see
   `~/apps/za-pos/prompts/deploy-coolify-oci.md` for the rest):
   ```
   NODE_ENV=production
   PORT=3000                  # Coolify injects; shown for clarity
   DB_PATH=/data/za-pos.db    # persistent volume below
   BACKUP_DIR=/data/backups   # MUST be inside the volume — unset puts snapshots
                              # in the container layer, where a rebuild eats them
   JWT_SECRET=<64-char random>
   CONTROL_PLANE_TOKEN=<token from step 1>   # enables /api/internal/*
   LEASE_PUBLIC_KEY=<control plane's public verification key>
   LEASE_KEY_ID=k1
   APP_URL=https://<slug>.<domain>      # unguarded: forgetting it gives localhost links
   TRUST_PROXY=1                        # hop count; 0 (default) makes the login
                                        # limiter key on the proxy address
   ```
   Two tenant-side traps worth stating here, because both fail **open**:
   `LEASE_PUBLIC_KEY` is *not* a boot gate — blank or malformed leaves the store in
   "unlicensed dev mode", where licences are accepted but cannot be verified and
   feature gates are permissive; and the key is only challenged on the first
   verification, so confirm the licence reads **active** after the first push
   rather than assuming it. Get the key from `GET /api/stores/licence/key` on this
   control plane.
4. **Persistent Storage:** named volume mounted at `/data` (this is the
   store's SQLite DB — never share it between stores).
5. **Domains:** `https://<slug>.vula-app.co.za` (Let's Encrypt via Caddy). Health
   check hits the app's `/health`.
6. **Deploy.** The store is now reachable at `https://<slug>.vula-app.co.za` and
   serves `/api/internal/*` when `CONTROL_PLANE_TOKEN` is set (bad/absent
   token → 401/404).

## Part B — onboard the store in the control plane

1. Control plane → **New store**:
   - name (display), slug (lowercase, dashes; fixed after creation),
   - VAT registration no. (optional),
   - base URL `https://<slug>.vula-app.co.za` (no trailing slash needed),
   - terminal count (1–99),
   - control plane token: **paste the token from Part A step 1** — it must
     equal the store's `CONTROL_PLANE_TOKEN` env. Leave blank only if you
     intend to generate one here and update the store's env to match.
2. Creation **attempts the first push** of `Till 1..N` to
   `POST /api/internal/configure` with that token. Success → row shows
   **Configured**; failure → row shows **Push failed** (usually a token
   mismatch — check Part A / troubleshooting) and you retry with **Push now**.
3. Confirm from the row: terminal chips `Till 1..N`, **Health** → `Up`, and
   optionally **Admin password** → the store resets its admin login and the
   temp password is shown once (never stored here).
4. If this merchant has a Head Office, pair the branch credential — the panel
   authenticates to the branch with `HEAD_OFFICE_TOKEN`, and the branch only
   answers when its own `settings.head_office_token` matches. Register the branch
   on the panel (`POST /api/internal/branches` on the panel, with the branch's
   token) or set it on the panel's Stores page. Skip this and the panel reports a
   perfectly healthy branch as **Offline** — the single most confusing failure in
   this system, because it looks like an outage rather than a missing token.

## Part C — deploy the control plane itself

1. Coolify → **New Resource → Private Repository (GitHub)** →
   `za-pos-control-plane` repo → branch `main` → **Build Pack: Dockerfile** →
   **Ports Exposes: 3000** (the image listens on `PORT`, default 3240;
   Coolify injects `PORT=3000` for the proxy).
2. Environment variables:
   ```
   NODE_ENV=production
   PORT=3000
   CP_DB_PATH=/data/control-plane.db
   OFFICE_ADMIN_EMAIL=you@example.com       # boot fails without these
   OFFICE_ADMIN_PASSWORD=<strong password>  # placeholder → boot fails
   JWT_SECRET=<64-char random>              # openssl rand -base64 64
   LEASE_PRIVATE_KEY=<base64url PKCS#8 DER> # signs licences; without it the CP
                                            # exits on first licence issue
   LEASE_KEY_ID=k1
   CP_TRUST_PROXY_HOPS=1                  # hops in front of the app (Coolify = 1);
                                          # 0 = ignore X-Forwarded-For entirely, which
                                          # makes the office login limiter key on the
                                          # proxy address
   HEALTH_SWEEP_INTERVAL_MINUTES=10       # keeps health/version honest; 0 = manual
   BILLING_TICK_INTERVAL_MINUTES=1440     # daily: marks lapsed invoices overdue and
                                          # raises renewals; 0 = manual
   MANAGED_ENDPOINT_SUFFIXES=.vula-app.co.za
                                          # the approved deployment domain; production
                                          # refuses a store or panel URL outside it
   COOLIFY_API_URL / COOLIFY_API_TOKEN      # needed to auto-provision
   COOLIFY_PROJECT_UUID / COOLIFY_SERVER_UUID / COOLIFY_GITHUB_APP_UUID
   LOG_LEVEL=info
   ```
   **Start from an empty registry.** Do not lift the development database into
   production: it holds demo clients, dozens of `localhost` rows and demo invoices.
   The schema and the seeded plans are created at boot; onboard real clients from
   there. (And in production the managed-endpoint policy refuses `http://` and
   private addresses outright, so a lifted `localhost` row could not be re-saved.)
   Two things this block used to warn about, both **fixed 2026-09-14** and no
   longer traps: the image's default, `EXPOSE` and healthcheck all agree on
   **3000**, matching the `PORT` Coolify injects — so the proxy and the probe
   cannot disagree; and `LEASE_PRIVATE_KEY` is checked **at boot**, so a
   production CP without a key refuses to start instead of dying on its first
   licence issue.
3. **Persistent Storage:** volume mounted at `/data` (registry DB + WAL), host
   path `/data/apps/vula-app/control-plane/<env>` per the production layout
   (`control-plane/prod`, `control-plane/staging`). It must be owned by uid 1000
   before first start: the container runs as `node` and a bind mount overrides
   the image's `chown`, so a root-owned directory stops SQLite creating its WAL.
   (The image's entrypoint now makes a root-owned `/data` writable and drops to
   `node`, which covers a directory that becomes root-owned later.)
4. **Domains:** `https://vula-cp-mzsza-2026.vula-app.co.za` → **Deploy**.
   Healthcheck hits `/health` (`{ status: 'ok' }`).
5. **After the first boot — Settings.** This is configuration, not env: sign in and
   set the office identity (the name that appears on invoices), the payment terms,
   and the SMTP account, then press **Send test email** and confirm it arrives.
   Until a mail server is configured, "Email to client" refuses with
   `smtp_not_configured` rather than reporting a send nobody received. No env var
   and no headless browser is needed for invoice mail — the PDF is drawn
   server-side with pdfkit.

## Day-2 operations

| Need                                 | How                                                                 |
| ------------------------------------ | ------------------------------------------------------------------- |
| Change a store's terminal count      | Edit the store → **Push now** (edits never auto-push)               |
| Store unreachable / flapping         | **Health** per store; rows keep last up/down + time                 |
| Cashier locked out at a store        | Store row → **Admin password** (one-time temp password, shown once) |
| Take a store offline for maintenance | **Pause** — push and admin reset are refused (409) until **Resume** |
| Add another store                    | Repeat Part A + Part B                                              |
| Send a client their invoice          | Billing → the invoice → **Email to client** (the PDF is attached)   |
| Bill a once-off charge               | Billing → **Raise an Invoice** — an unbilled onboarding charge rides on it unless unticked |
| Change mail account / invoice terms  | **Settings** — identity, payment terms, SMTP (+ test send)           |

## Troubleshooting

- **First push / Push now fails with "Invalid control plane token"** — the
  registry row and the deployment disagree about the credential. Paste the store's
  `CONTROL_PLANE_TOKEN` (from its Coolify env) into the store's **Configure** modal
  — *Control-plane token* — and save; the next push authenticates. Do **not** delete
  and recreate the row: that path was the only one before 2026-09-16 and it throws
  away the store's history, licence allocation and deployment jobs.
- **First push / Push now fails (502, or row goes red)** — check in order:
  1. the credential above;
  2. `https://<slug>.vula-app.co.za/health` responds and the domain resolves;
  3. the store image ships `/api/internal/*` (shipped in za-pos 2026-09-03 —
     CONTEXT.md §4 is the contract reference; `npm run stub` in the CP repo
     is a dev stand-in);
  4. the store isn't behind a firewall that blocks the control plane's egress.
- **Health shows Down but the store works in a browser** — the ping uses
  `GET /api/internal/status` with the token header; check the store logs for
  401s (token mismatch) and confirm the internal router is mounted.
- **"Email to client" refuses (400 `smtp_not_configured`)** — that is the honest
  answer, not a fault: set the SMTP account on **Settings** and send the test.
- **Invoice email fails 502 `mailer_failed`** — the relay refused the message; the
  reason is in the response and in the audit trail (`invoice_emailed`, `failed`).
- **CP won't boot (production)** — check `OFFICE_ADMIN_EMAIL`,
  `OFFICE_ADMIN_PASSWORD` (not the placeholder), `JWT_SECRET` and
  `LEASE_PRIVATE_KEY`; the boot gate exits with a FATAL line naming the missing
  variable.
- **Registry lost?** — restore `data/control-plane.db` from the volume
  backup, or re-onboard stores (their `CONTROL_PLANE_TOKEN` env values on the
  store containers must match freshly created rows — see first bullet).

## Updating

Push to GitHub → Coolify auto-rebuilds (both workloads). Volumes persist.
DB schema changes are auto-migrated at boot (columns are additive in v1).
