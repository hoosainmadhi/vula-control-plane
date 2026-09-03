# Deploy Vula stores + the Control Plane on Coolify (OCI)

Two kinds of workload, both private-GitHub-repo Dockerfile builds on the same
Coolify (OCI) server:

- **Store apps** — the per-store Vula deployment (`~/apps/za-pos` repo, one
  container per store, one SQLite DB per store in its own volume).
- **This control plane** — `~/apps/za-pos-control-plane` repo, one container,
  registry DB in its own volume.

The control plane does **not** provision Coolify in v1 (no Coolify API
integration) — deploying a store is manual, then you onboard it here.

## Prerequisites

- Coolify resource creation rights; a GitHub App covering both repos
  (`za-pos` and `za-pos-control-plane`), or public repos.
- DNS once **vula-app.co.za** is registered: wildcard `*.vula-app.co.za` →
  the Coolify server so every store answers at `<slug>.vula-app.co.za`, plus
  `cp.vula-app.co.za` for this panel (store slug = the store's registry slug).

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
   JWT_SECRET=<64-char random>
   CONTROL_PLANE_TOKEN=<token from step 1>   # enables /api/internal/*
   APP_URL=https://<slug>.vula-app.co.za
   ```
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
   OFFICE_ADMIN_EMAIL=you@example.com      # boot fails without these
   OFFICE_ADMIN_PASSWORD=<strong password> # placeholder → boot fails
   JWT_SECRET=<64-char random>             # openssl rand -base64 64
   LOG_LEVEL=info
   ```
3. **Persistent Storage:** volume mounted at `/data` (registry DB + WAL).
4. **Domains:** `https://cp.vula-app.co.za` → **Deploy**. Healthcheck hits
   `/health` (`{ status: 'ok' }`).

## Day-2 operations

| Need                                 | How                                                                 |
| ------------------------------------ | ------------------------------------------------------------------- |
| Change a store's terminal count      | Edit the store → **Push now** (edits never auto-push)               |
| Store unreachable / flapping         | **Health** per store; rows keep last up/down + time                 |
| Cashier locked out at a store        | Store row → **Admin password** (one-time temp password, shown once) |
| Take a store offline for maintenance | **Pause** — push and admin reset are refused (409) until **Resume** |
| Add another store                    | Repeat Part A + Part B                                              |

## Troubleshooting

- **First push / Push now fails (502, or row goes red)** — check in order:
  1. the store's `CONTROL_PLANE_TOKEN` env equals the token the control plane
     generated at store creation (the registry never displays it — if it was
     lost, delete and recreate the store row; v1 has no token-rotation UI);
  2. `https://<slug>.vula-app.co.za/health` responds and the domain resolves;
  3. the store image ships `/api/internal/*` (shipped in za-pos 2026-09-03 —
     CONTEXT.md §4 is the contract reference; `npm run stub` in the CP repo
     is a dev stand-in);
  4. the store isn't behind a firewall that blocks the control plane's egress.
- **Health shows Down but the store works in a browser** — the ping uses
  `GET /api/internal/status` with the token header; check the store logs for
  401s (token mismatch) and confirm the internal router is mounted.
- **CP won't boot (production)** — check `OFFICE_ADMIN_EMAIL`,
  `OFFICE_ADMIN_PASSWORD` (not the placeholder) and `JWT_SECRET`; the boot
  gate exits with a FATAL line naming the missing var.
- **Registry lost?** — restore `data/control-plane.db` from the volume
  backup, or re-onboard stores (their `CONTROL_PLANE_TOKEN` env values on the
  store containers must match freshly created rows — see first bullet).

## Updating

Push to GitHub → Coolify auto-rebuilds (both workloads). Volumes persist.
DB schema changes are auto-migrated at boot (columns are additive in v1).
