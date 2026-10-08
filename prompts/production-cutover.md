# Production cutover — control plane, stores, Head Offices

The sequence for going live on a real domain, across three workloads in two repos.
The per-app details live in `prompts/deploy-coolify-control-plane.md` (this repo)
and `~/apps/za-pos/prompts/deploy-production-vula-app.md` (tenant) — this file is
the order, the decisions, and the checks that are easy to forget.

Written 2026-09-25, after the production review's four passes. Where the examples
say `vula-app.co.za`, substitute the registered domain.

---

## 0. Decisions — locked with the owner (2026-09-29)

| # | Decision | State |
| - | -------- | ----- |
| D1 | **Hostname scheme confirmed**: stores `<slug>.vula-app.co.za`, Head Offices `<company-slug>-ho.vula-app.co.za`, control plane `vula-cp-mzsza-2026.vula-app.co.za` — obscure on purpose; the panel is not meant to be discoverable. | Locked |
| D2 | **Clean registry**: production boots with no companies, no stores and no demo invoices; real clients are onboarded from there. The development database is not lifted (its `localhost` rows would be refused by the managed-endpoint policy anyway). | Locked |
| D3 | **Backups**: nightly `sqlite3 .backup` of the control-plane registry, every store database and every Head Office database on the host, copied off-host, 30-day retention, restore drill before go-live and quarterly after. Script and schedule in §9. | Script ready; cron to install on the host |
| D4 | **Secrets**: generated per §4 and kept in a password manager as the source of record. Plaintext-at-rest accepted for launch with the mitigations in §10 (single operator, obscure panel hostname, host treated as the perimeter); field-level encryption deferred to tidbits. | Accepted for launch |
| D5 | **Branch**: production deploys from `main`; promote after the §2 review. | **Open — the owner's merge** |

## 1. Close the tenant's fail-open traps before a store trades

**All four are fixed 2026-09-29 on the tenant's `dev` branch** (see its
`progress.md`) — the lease key is a production boot gate on both apps,
`APP_URL` is required, the Head Office database path honours its fallback, and
the seed gate refuses production. Re-verify with the licence-activation check in
§6 after the first deploy.

Originally all four were verified by reading the code:

1. **`LEASE_PUBLIC_KEY` is not a boot gate.** Blank or malformed leaves the store
   in *unlicensed dev mode*: licences are accepted but **not verified**, and every
   feature gate is permissive (`src/services/licence.ts`). The key is only
   challenged on the first verification attempt. Either make it a boot gate, or
   confirm after deploy that the store reports the licence **active**.
2. **`APP_URL` is unguarded.** Forgetting it produces receipt links pointing at
   `http://localhost:3230` (`services/receiptPdf.ts`). Set it per store.
3. **The Head Office `HO_DB_PATH` guard accepts `DB_PATH`** — and the config then
   never reads `DB_PATH`, so a deployment setting only `DB_PATH` passes the boot
   gate and writes its database into the container layer, where a rebuild eats it.
   The image sets `HO_DB_PATH`, which masks this; set it explicitly anyway.
4. **`SEED_DEMO_DATA` must be unset or `false`.** Set to `true` in production it
   seeds a known executive login (`executive@urban-threads.co.za`) and demo data.

Also set `TRUST_PROXY=1` on stores and Head Offices (hop count, not a boolean) —
without it the login limiter keys on the proxy's address rather than the client's.

## 2. Promote to `main` (production deploys from `main`)

Coolify tracks a branch and auto-deploys it, so **merging is deploying** once the
resources exist. Do this deliberately, per repo:

- **This repo:** the session's work (licence-sequence repair, settlement
  correctness, the strict billing state machine, the managed-endpoint policy, the
  proxy-aware limiter, the daily billing tick, nested payload validation, the
  frontend suite) is on `dev`. `main` is roughly two weeks behind.
- **Tenant repo:** same check — confirm what `main` is missing before pointing a
  production resource at it.

Gate for both: the suites green (`npm run test:all` here) plus a review of the
`dev..main` diff. Do not deploy an unreviewed merge to a fleet that will hold real
customer databases.

## 3. DNS and TLS

1. **One wildcard record covers nearly everything**: `*.vula-app.co.za` → the
   Coolify host. That includes every store (`<slug>.vula-app.co.za`), every
   merchant Head Office (`<company-slug>-ho.vula-app.co.za`) and the control plane
   itself (`vula-cp-mzsza-2026.vula-app.co.za`).
2. Per Coolify resource: **Automatic SSL** (Let's Encrypt) with the resource's
   domain set — the panel's is `vula-cp-mzsza-2026.vula-app.co.za`.
3. **The certificate must be live before the first store row is created.** From
   the Pass 2 policy, production refuses a store URL that is plaintext, private,
   or does not answer — the app-kind probe has to succeed at registration.
4. Set `MANAGED_ENDPOINT_SUFFIXES=.vula-app.co.za` on the control plane so the
   approved-domain allowlist matches the scheme (review §8: the control plane
   dials only hosts on the deployment domain).
5. **The Coolify GitHub App must have both repos granted.** Store and Head
   Office deployments build from the tenant repo (`hoosainmadhi/vula-app`);
   the control plane builds from its own. A missing grant surfaces as
   "Repository not found or not accessible by the GitHub App" on the wizard's
   deploy step — add the repo in the GitHub App's settings (Repository
   access), then retry the deployment job. Found in the staging rehearsal
   (2026-10-02): the CP had inherited optimed's app (`digicure-githubapp`),
   which held `vula-control-plane` but not the tenant repo — and the CP's old
   repo default named `hoosainmadhi/za-pos`, a repo that does not exist.

## 4. Secrets inventory

Generate once, store in a password manager, paste into Coolify (never into git):

| Secret | Scope | How |
| ------ | ----- | --- |
| `OFFICE_ADMIN_PASSWORD` | control plane | strong, unique; the placeholder fails the boot gate |
| `JWT_SECRET` | control plane | `openssl rand -base64 64` |
| `LEASE_PRIVATE_KEY` / `LEASE_KEY_ID` | control plane | `npx tsx scripts/generate-licence-key.ts`; boot fails without it |
| `CONTROL_PLANE_TOKEN` | per store, per Head Office | `openssl rand -hex 32` — same value in the deployment env and the registry row |
| `JWT_SECRET` (store) / `HO_JWT_SECRET` (panel) | tenant | ≥32 chars, not a placeholder, or boot fails |
| SMTP account | control plane | set in **Settings** after first boot, then **Send test email** |

The control plane publishes the verification key at `GET /api/stores/licence/key`
(and `/api/panels/licence/key`); every store and Head Office needs it as
`LEASE_PUBLIC_KEY` + `LEASE_KEY_ID=k1`.

## 5. Deploy order

1. **Control plane** — it holds the signing key and the registry.
2. **Settings** — office identity (the name on invoices), payment terms, SMTP, and
   the VAT registration/rate if invoicing tax.
3. **One store** (Part A of the CP runbook) → register it (Part B).
4. **Verify** (§6) before onboarding a second store.
5. **Head Office**, if the client is multi-store — then wire the branch topology
   (the panel otherwise reports a healthy branch as *Offline*; that is the most
   confusing failure in this system).

## 6. Verification

Per store, in the panel: **Health** → `Up`; **Configured** with the right
`Till 1..N`; the licence column **active** (not "unlicensed"); `GET
/api/internal/status` on the store reports the expected `maxTerminals` and a
licence `sequence` ≥ 1. Per Head Office: **Diagnostics** green and the branch
roster matching the client's stores.

On the control plane itself: `/health` answers; **Errors** is empty; **Deployments**
shows the job and its steps; and the first scheduled health sweep (10 minutes after
boot) leaves the fleet's health and versions fresh rather than deploy-time.

## 7. Staging dress rehearsal (run this before §8)

The `staging` branch is the release candidate: promote `dev → staging`, deploy
the same three workloads on staging hostnames, and rehearse the entire go-live
sequence — including the failure paths — on real Coolify infrastructure. A
staging that has never rehearsed a deploy is a hope with a hostname.

**Hostnames** (single-label, all covered by the existing `*.vula-app.co.za`
wildcard — no second wildcard record needed):
- Control plane: `staging-cp.vula-app.co.za`
- Stores: `staging-<slug>.vula-app.co.za`
- Head Office: `staging-ho-<company-slug>.vula-app.co.za`

**Secrets**: a **separate keypair** (`npx tsx scripts/generate-licence-key.ts`) —
the staging fleet must not share the production trust root, or a leaked staging
private key signs production licences. Its own `CONTROL_PLANE_TOKEN` per
workload, its own JWT secrets, and a test SMTP account (Mailhog/Mailtrap on the
host, or a plain inbox you own).

**Differences from production (deliberate, and none of them weaken a gate)**:
the database volumes are staging-only; the SMTP account is a test inbox; and the
Head Office bootstraps its executive via `POST /api/internal/admin/init` rather
than seeded demo data — the `SEED_DEMO_DATA` boot gate refuses production and
staging alike, which is correct: the rehearsal should walk the real activation
path, not receive a known login.

**Rehearse, in order**:
1. Deploy the control plane → Settings (office identity, the test SMTP) → send
   the test email.
2. Run the backup script's first pass (§9) and confirm the three databases land
   off-host.
3. Onboard a client on a multi-store plan → raise the initial invoice → record
   the payment → confirm the client flips to `active`.
4. Deploy a store → licence accepted, register **trading**, Head Office sees the
   branch → ring a sale, confirm it reaches the Head Office summary.
5. The failure paths: pause a store mid-sale (refusals, resume), a licence push
   to a stopped store (recorded, retried by the sweep), and a wrong-app-kind
   registration (refused).
6. The restore drill (§9): restore the backup into a scratch container, boot it,
   confirm a client, a store and an invoice are readable.

**Then promote**: `staging → main`, and repeat §8's verification on the
production resources. A staging that validated the whole sequence is the
strongest argument the production deploy is uneventful.

## 8. Go-live sequence for the first real client (easy to miss)

The billing state machine is strict since 2026-09-25: **a client that has never
paid derives `suspended`, and a suspended client cannot trade.** Onboarding alone
does not make a client active. The sequence that does:

1. Onboard the client (wizard: company + subscription + deployment).
2. Raise the initial invoice — the once-off onboarding charge rides on whichever
   invoice is raised next.
3. **Record the payment** once the EFT lands. That is what writes `paid_through`
   and moves the client to `active`; the panel does not charge anyone, it records
   what happened.
4. Confirm the register reads **active** and the licence has been re-pushed.

The daily billing tick (`BILLING_TICK_INTERVAL_MINUTES`, default 1440) marks lapsed
invoices `overdue` and raises renewals. It never records a settlement, by design —
so a client whose payment has arrived but was never recorded stays suspended and
stops trading.

## 9. Day-2

- **Upgrades:** migrations run on every database open and some rebuild tables.
  Expect a short gap, not zero downtime, and snapshot the database before a schema
  change. Rollback is the previous image plus its matching database.
- **Support access:** a store admin login is issued from the store row
  (**Admin password** — one-time temp password, shown once, never stored).
- **Pausing:** a store can be paused for maintenance (push and admin reset are
  refused while paused); a Head Office tears down pause-first too.
- **Volumes are keyed by name** in Coolify: renaming the layout path applies to new
  deployments only, and orphans existing data.

## 10. Backups (D3) — mechanism, schedule, drill

No app in the fleet schedules a backup, and a bare `.db` copy is not one (the WAL
can hold most of the data). On the Coolify host, with `sqlite3` installed:

```bash
#!/usr/bin/env bash
# /usr/local/bin/vula-backup.sh — nightly from root's crontab, e.g.
#   10 2 * * * /usr/local/bin/vula-backup.sh    (before the 02:17 demo reset)
set -euo pipefail
STAMP=$(date +%Y%m%d-%H%M%S)
DEST=/backups/vula-app            # a second disk, or rsync'd off-host after
ROOT=/data/apps/vula-app

# The fleet's data tree (bind-backed volumes, migrated 2026-10-06). The backup
# mirrors the tree, so a restore is a copy back into place. The demo clients
# (`demo-*` / `*-demo`) are skipped by the owner's decision: they reset to
# their goldens nightly and are regenerable from the seeders, so their dailies
# were noise — the goldens are their protection.
backup() { # db-path relative-dest
  local db=$1 rel=$2
  [ -e "$db" ] || return 0
  mkdir -p "$DEST/$rel"
  sqlite3 "$db" ".backup '$DEST/$rel/$(basename "$db" .db)-$STAMP.db'"
}
for db in "$ROOT"/control-plane/*/control-plane.db; do
  rel=${db#"$ROOT"/}; backup "$db" "${rel%/*}"
done
for clientdir in "$ROOT"/clients/*/; do
  client=$(basename "$clientdir")
  case "$client" in demo-*|*-demo) continue;; esac
  for db in "$clientdir"head-office/*.db "$clientdir"stores/*/*.db; do
    rel=${db#"$ROOT"/}; backup "$db" "${rel%/*}"
  done
done

# Any deployment still on a plain named Docker volume (the API's fallback) is
# caught here; bind-backed volumes are skipped — their `_data` is the same
# inode as the tree path above.
DOCKER_ROOT=$(docker info --format '{{.DockerRootDir}}')
for vol in $(docker volume ls --format '{{.Name}}' | grep -- '-vula-' || true); do
  [ -n "$(docker volume inspect "$vol" --format '{{index .Options "device"}}' 2>/dev/null)" ] && continue
  for db in "$DOCKER_ROOT/volumes/$vol/_data"/*.db; do
    [ -e "$db" ] || continue
    backup "$db" "legacy-volumes/$vol"
  done
done

# Off-host, then prune. Off-host is the part that survives the host.
rsync -a --delete "$DEST/" backup@backup-host:/srv/vula-backups/
find "$DEST" -path "$DEST/demo-golden" -prune -o -name '*.db' -mtime +30 -exec rm -f {} +
```

`.backup` uses SQLite's online backup API, so it is consistent while the apps
write and produces one self-contained file — no WAL to carry. Retention: 30
nights on the backup disk, plus a monthly copy kept a year. **Drill before
go-live and quarterly after**: restore a copy to a scratch container, boot it,
sign in, and confirm a client, a store and an invoice are readable — an
unrestored backup is a hope, not a backup.

**Storage is a bind-backed volume in one tree.** Coolify 4.3.23's API refuses
bind mounts outright (`host_path` → "not allowed") and exposes nothing that can
create one, so each deployment keeps the named volume Coolify made — and that
volume is re-pointed at the host tree with the local driver:

```
docker volume create --driver local --opt type=none \
  --opt device=/data/apps/vula-app/clients/<client>/stores/<store> \
  --opt o=bind <volume-name>
```

`scripts/vula-bind-storage.sh <app-uuid> <volume-name> <host-dir>` does that
safely: stop, verify (or make) a byte-identical copy in the target, park the
original under `/root/vula-migration-backup`, swap the volume, and leave the
container stopped for a Coolify deploy to recreate. Run it once per newly
provisioned deployment, then deploy. **Migrated 2026-10-06:** 11 fleet
deployments and both control planes; the whole fleet's data is ~18 MB under
`/data/apps/vula-app/`. Coolify's UI still shows a volume — that is the point of
the trick; the volume's `_data` and the tree path are the same inode.

## 11. Accepted at launch (recorded, not forgotten)

- **Secrets at rest**: tokens and the SMTP password are plaintext in the SQLite
  databases. Mitigations: one operator, an obscure panel hostname, the control
  plane host treated as the perimeter (it holds every store token and the licence
  private key), and off-host backups on a trusted target. Field-level encryption
  is deferred and tracked in tidbits.
- **The login limiter's counters are per-process** — a restart clears them, and
  two replicas would not share them.
- **DNS resolution and the later fetch are independent**, so a fast-rebinding
  record is not caught by the address policy.
- **Panel authentication** is one admin with a 7-day JWT and no roles — MFA and
  RBAC are the pre-wide-exposure upgrade, not a launch blocker for a single
  operator.
