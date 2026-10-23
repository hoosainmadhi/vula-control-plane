# Vula Control Plane — How It Works

**Status:** current as of 2026-10-23. One codebase serves the two permanent
Control Planes. The temporary M4 Control Plane remains only as a reference
environment and is no longer part of the production path.

| Environment    | URL                                         | Role                                                            |
| -------------- | ------------------------------------------- | --------------------------------------------------------------- |
| Staging        | `https://staging-cp.vula-app.co.za`         | Marketing demos and rehearsals                                  |
| Production     | `https://vula-cp-mzsza-2026.vula-app.co.za` | Real merchant accounts                                          |
| M4 (temporary) | `https://m4-cp.vula-app.co.za`              | Historical shared-image validation; keep until no longer needed |

Deployed code: commit `f36157f` (docs head `0faa085`) on both permanent
Control Planes. Production and staging have separate databases, volumes,
Coolify credentials, admin logins and JWT secrets.

---

## 1. What the Control Plane is

The Control Plane (CP) is the vendor-side fleet manager. It does **not** sit in
the sales path of a store. It:

- keeps the merchant registry: companies/clients, stores, Head Offices, plans,
  subscriptions, invoices, payments, quotes and deployment jobs;
- provisions and configures tenant applications in Coolify;
- pushes terminal configuration and licences to stores and Head Offices;
- tracks health, versions, releases and deployment history;
- serves the office UI at `:3000` behind HTTPS, with the API under `/api`.

Each tenant is one Coolify application with its own SQLite database on its own
`/data` volume. The CP registry is a separate SQLite database on the CP's own
`/data` volume. No tenant database is ever mounted by the CP, and no two tenant
containers share a SQLite database.

---

## 2. The two deployment models

### 2.1 New way — build once, deploy shared images

This is the target model and the standard for **new stores**.

1. Build the tenant application **once** from the accepted tenant commit, for
   the fleet architecture (`linux/arm64` on the current Coolify host).
2. Publish it to GHCR (`ghcr.io/hoosainmadhi/vula-pos-store` or
   `.../vula-pos-ho`) and record the immutable manifest digest
   (`sha256:<64 hex>`), version and revision.
3. Register the release in the CP catalog:
   - kind: `store` or `ho`
   - tag, digest, version, revision
   - channel: `stable`, `beta`, `canary`
   - schema version the image creates, and the schema range it can open
   - notes
4. Provision a tenant as a Coolify **Docker Image** application, pinned to the
   digest. No Git checkout, no Dockerfile, no per-tenant build.
5. Upgrade and roll back by changing the pinned digest through the Releases
   page; the CP stops the old container first and verifies the new one.

### 2.2 Old way — per-tenant Dockerfile build

The legacy path clones the tenant repository and builds a Dockerfile inside
Coolify for every tenant. It is still what the existing demo and rehearsal
tenants run. It has no immutable image digest and cannot be upgraded in place
to a shared image.

### 2.3 Which way is used now

| Situation                                           | Path                                                                                         |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| New **store**, stable image release registered      | **New way** (shared image)                                                                   |
| New **store**, no stable release                    | Production: refused. Staging: Dockerfile only with `ALLOW_LEGACY_DOCKERFILE_ONBOARDING=true` |
| New **Head Office**, stable `ho` release registered | **New way** (shared image)                                                                   |
| New **Head Office**, no `ho` release                | Production: refused. Staging: Dockerfile fallback if explicitly enabled                      |
| Existing Dockerfile tenant                          | Stays on the old way. Image upgrade/rollback is disabled with a blue/green explanation       |
| Existing shared-image tenant                        | New way: digest upgrades, schema-checked rollback, waves                                     |

**Current production readiness:**

- Store release **A** (`v2026.10.21-5781c2c`, stable) is registered.
- Store release **B** (`v2026.10.23-86ed3e1-m4b`) is **beta and staging-only**.
- Head Office release **A** (`v2026.10.21-5781c2c`, stable, ARM64) is
  registered in both catalogs. Production can now onboard a new multi-store
  client's Head Office through the new image path; the first such onboarding is
  the acceptance test for GHCR pull access.
- Existing Dockerfile tenants are not migrated automatically. Moving one to the
  new path is a deliberate blue/green migration.

---

## 3. Release catalog and current releases

The catalog is `image_releases`, keyed by `kind` + immutable tag and digest.
Duplicate kind/tag and kind/digest combinations are refused. The digest is the
deployment identity; a moving tag alone is never used.

| Kind  | Tag                       | Channel | Schema | Where                |
| ----- | ------------------------- | ------- | ------ | -------------------- |
| store | `v2026.10.21-5781c2c`     | stable  | 1..1   | staging + production |
| store | `v2026.10.23-86ed3e1-m4b` | beta    | 1..1   | staging only         |
| ho    | `v2026.10.21-5781c2c`     | stable  | 1..1   | staging + production |

The Head Office image is the existing private GHCR artifact for commit
`5781c2c`, digest
`sha256:d50f979c3c7a9f1dfdd51928cecf9f29ca6fd01f7dbfb594905b5c34ecb6a9d6`.
It is ARM64 and reports the same version/revision as Store release A, so the
pair is matched.

The M4 test release `v2026.10.23-schema-gate` (digest `sha256:ffff…`) was a
deliberate incompatible test artefact and was **not** copied to either
permanent catalog.

### 3.1 Publishing a release

Use **Releases → Publish release** or `POST /api/releases`. The form requires
the exact tag, digest, version, revision, channel and schema range. Publishing
is audited. A release is immutable once registered.

### 3.2 Onboarding picks a release

When a new tenant is provisioned and a stable release exists for its kind, the
CP uses the **latest active stable** release. It creates a Docker Image app,
pins the digest, creates a per-tenant volume, injects the runtime environment
and verifies the deployment and `/health` before marking the tenant deployed.

### 3.3 Upgrade behaviour

1. Acquire the per-tenant deployment lock.
2. Check the current database schema against the target's declared range.
3. Preflight the Coolify app: `/data` storage present, tenant identity matches,
   app UUID allowlisted for image changes.
4. Stop the old container and wait until Coolify reports it is gone
   (`container_present=false`). This prevents two SQLite writers.
5. Patch the image to `<repo>@sha256` plus the digest hex tag, trigger the
   deployment, and poll the Coolify deployment record to a terminal success.
6. Poll the tenant's own `/health` until it reports the exact release version,
   revision and `database: connected`.
7. Record the new digest/tag/release, keep the previous release, and write the
   deployment history and audit rows.

A failed deployment is recorded as failed and does not rewrite the tenant's
current release fields. There is no automatic rollback; the operator chooses a
schema-safe target.

### 3.4 Rollback rules

Rollback returns to the release the tenant ran **before the current release was
applied**. The target is derived from verified successful forward deployment
history, not from `previous_release_id`:

- `A → B → rollback A`: no rollback target. B is a forward move and remains
  available through **Upgrade**.
- `A → B → C → rollback B`: target is A, not C (the release just left).
- A caller-supplied target that is not the server-verified target is refused
  with `409 rollback_not_eligible`.

The target must also be in the catalog, active, the same kind, and able to open
the tenant's current database schema. The button is disabled with the reason
when no valid target exists.

### 3.5 Waves

**New rollout** supports tenant selection, wave size, dry run and
stop-on-failure. Each tenant still takes its own lock and schema check. A dry
run records the plan without calling Coolify. With stop-on-failure enabled, a
failed wave prevents later waves from starting.

### 3.6 Who can change releases

Release reads require an office session. Every release mutation (publish,
apply, rollback, wave, channel change, reconcile) requires the logged-in email
to be in `RELEASE_MANAGER_EMAILS`. An empty list means no mutations. The UI
disables the controls for non-managers, and the server enforces the same rule.

Current allowlists:

- Staging: `office@staging.vula-app.co.za`
- Production: `hello@vula-app.co.za`

---

## 4. Existing Dockerfile tenants

Every store and panel now carries an explicit `deploy_mode`:

| Mode            | Meaning                                                         |
| --------------- | --------------------------------------------------------------- |
| `image`         | Shared-image application, provisioned by the release controller |
| `dockerfile`    | Legacy per-tenant Dockerfile build                              |
| `unprovisioned` | Registered in the CP but no Coolify application yet             |

Existing rows were classified once after the consolidation: an image digest
means `image`; a Coolify UUID without an image digest means `dockerfile`; no
UUID means `unprovisioned`. New rows are classified by the provisioning path,
not by inference.

What the UI and API do for `dockerfile` tenants:

- The fleet shows a **Dockerfile legacy** badge.
- Upgrade and Rollback are disabled with a blue/green migration explanation.
- `POST /api/releases/tenants/.../apply` returns
  `409 dockerfile_requires_blue_green` before any Coolify call.
- The tenant continues to run normally; only image-release actions are blocked.

### 4.1 Blue/green migration (not automatic)

To move an existing Dockerfile tenant to shared images:

1. Create a new Docker Image application from the desired release and a **new**
   `/data` volume. Do not convert the old app in place.
2. Stop the old container, take a consistent SQLite backup, copy the database
   to the new volume, and start the new app.
3. Verify the new app's `/health`, database schema and data.
4. Switch DNS to the new app, keep the old app stopped as the rollback path,
   then decommission it after acceptance.

This is a separate, deliberate operation. The consolidation did not migrate any
existing tenant.

---

## 5. Data model and current state

### 5.1 Main registry tables

| Area         | Tables                                                                            |
| ------------ | --------------------------------------------------------------------------------- |
| Merchants    | `companies` (clients), `plans`, `company_subscriptions`                           |
| Tenants      | `stores`, `panels` (Head Offices), `store_terminal_licences`                      |
| Money        | `invoices`, `payments`, `billing_settings`                                        |
| Documents    | `quotes`                                                                          |
| Provisioning | `deployment_jobs`, `deployment_locks`                                             |
| Releases     | `image_releases`, `release_deployments`, `release_batches`, `release_batch_items` |
| Audit        | `audit_logs`                                                                      |

### 5.2 Deleting a client

A company can only be deleted when it owns **no stores, no Head Office and no
invoices**. Financial documents are retained: deleting a company would cascade
its invoices and payments. The correct way to stop a merchant trading is to set
its status to **Suspended** on **Company accounts**.

The production client list was deliberately reset to zero on 2026-10-23 at the
owner's request. That reset removed the one company (`Super Stores`) and its
paid invoice/payment in a transaction, with an audit row. Two quotes remain
unassigned (`company_id = NULL`) because the schema preserves quote documents.

### 5.3 Current state (2026-10-23)

**Production**

- 0 clients, 0 stores, 0 Head Offices
- 0 invoices, 0 payments, 0 deployment jobs
- 9 plans
- 2 catalog releases: store A stable + Head Office A stable
- 2 unassigned quotes
- `CP_ENVIRONMENT=production`; `running:healthy`

**Staging**

- 11 stores, 2 Head Offices, 8 companies
- 8 image demo stores + 2 Dockerfile rehearsal stores + 1 unprovisioned rehearsal store
- 1 image demo Head Office + 1 Dockerfile rehearsal Head Office
- Catalog: store A stable, Head Office A stable, store B beta
- `CP_ENVIRONMENT=staging`; `ALLOW_LEGACY_DOCKERFILE_ONBOARDING=true`
- Image actions remain blocked for the three legacy rehearsal tenants
- The marketing demos are fully migrated; see
  [`docs/demo-image-migration.md`](demo-image-migration.md)

**M4**

- Kept as a reference environment. No longer used for production release work.
- Its `VULA_STAGING_MODE` boundary and M4-specific names/domains must not be
  copied to `staging-cp`.

---

## 6. Configuration

### 6.1 Environment variables that matter operationally

| Variable                                                                   | Purpose                                                                                           |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `NODE_ENV=production`                                                      | Production boot gates (admin creds, JWT, lease key, managed suffixes)                             |
| `CP_ENVIRONMENT`                                                           | UI/API environment label: `staging` or `production`                                               |
| `CP_DB_PATH`                                                               | Registry SQLite path, `/data/control-plane.db`                                                    |
| `OFFICE_ADMIN_EMAIL` / `OFFICE_ADMIN_PASSWORD`                             | Office login; password is hashed at boot                                                          |
| `JWT_SECRET`                                                               | Signs office sessions; rotation invalidates all existing sessions                                 |
| `COOLIFY_API_URL` / `COOLIFY_API_TOKEN`                                    | Per-CP Coolify credential; never shared across apps                                               |
| `COOLIFY_PROJECT_UUID` / `COOLIFY_SERVER_UUID` / `COOLIFY_GITHUB_APP_UUID` | Tenant provisioning target                                                                        |
| `VULA_STORE_IMAGE` / `VULA_HO_IMAGE`                                       | GHCR image repositories                                                                           |
| `VULA_DATA_ROOT`                                                           | Host path root for tenant data                                                                    |
| `VULA_ALLOWED_APP_UUIDS`                                                   | Exact app UUIDs allowed for image changes; empty in production refuses existing-app image changes |
| `RELEASE_MANAGER_EMAILS`                                                   | Comma-separated office emails allowed to mutate releases                                          |
| `ALLOW_LEGACY_DOCKERFILE_ONBOARDING`                                       | Non-production only; explicit Dockerfile fallback                                                 |
| `VULA_STAGING_MODE`                                                        | **M4-only** isolated-creation boundary; do not enable on staging-cp                               |
| `RELEASE_HEALTH_TIMEOUT_MS` / `RELEASE_HEALTH_INTERVAL_MS`                 | Readiness polling budget (default 8 min / 5 s)                                                    |
| `RELEASE_LOCK_MINUTES`                                                     | Stale deployment-lock age (default 30)                                                            |
| `MANAGED_ENDPOINT_SUFFIXES`                                                | Allowed tenant domain suffixes                                                                    |
| `CP_TRUST_PROXY_HOPS`                                                      | Trusted proxy hops for client IPs                                                                 |

### 6.2 Backups

The CP's own registry is SQLite. Take an online backup with the SQLite backup
API, not by copying the live file:

```bash
sudo python3 - <<'PY'
import sqlite3
src = sqlite3.connect(
    "file:/data/docker/volumes/<cp-volume>/_data/control-plane.db?mode=ro",
    uri=True,
)
dst = sqlite3.connect("/tmp/control-plane-backup.db")
src.backup(dst)
dst.execute("PRAGMA journal_mode=DELETE")
dst.commit()
print(dst.execute("PRAGMA integrity_check").fetchone()[0])
PY
```

Verify `integrity_check=ok`, `PRAGMA user_version`, and the expected table
counts, then copy the backup off-host with mode 600.

Current retained backups in `~/.config/za-pos/backups/`:

| Backup                                      | SHA-256     | Contents                                         |
| ------------------------------------------- | ----------- | ------------------------------------------------ |
| `vula-cp-staging-registry-20261023.db`      | `3505230d…` | 11 stores, 2 panels, 8 companies                 |
| `vula-cp-prod-registry-20261023.db`         | `208fa9d5…` | pre-consolidation: 0 stores, 0 panels, 1 company |
| `vula-cp-prod-pre-client-reset-20261023.db` | `528d22a2…` | 1 company, 1 invoice, 1 payment                  |

### 6.3 Marketing demos

The eight demo stores are public at:

`demo-general`, `demo-hardware`, `demo-pharmacy`, `demo-restaurant`,
`demo-spares`, `demo-urban-threads-jhb`, `demo-urban-threads-cpt`,
`demo-urban-threads-dbn` — all under `*.vula-app.co.za`.

Their data is reset nightly:

- script: `/usr/local/bin/vula-demo-reset.sh`
- schedule: `/etc/cron.d/vula-demo-reset`, 02:17 daily
- log: `/var/log/vula-demo-reset.log`

The reset stops the demo containers, restores the golden SQLite files, removes
WAL/SHM files and restarts the containers. It is independent of the CP code and
was verified after the consolidation.

---

## 7. Operating the CP

### 7.1 Deploying CP code

Branch strategy: `dev` → `staging` → `main`.

1. Validate locally: `npm test`, `npm run test:ui`, `npm run typecheck`,
   `npm run build`.
2. Push the exact commit to `staging` and deploy `vula-cp-staging` in Coolify.
3. Verify `/health`, `/api/auth/me` environment, the main modules and the fleet.
4. Fast-forward `main` to the same commit and deploy `vula-cp-prod`.
5. Verify the same checks on production.

Pushing does not deploy: Coolify auto-deploy is off, so trigger the deployment
deliberately.

### 7.2 Health and checks

- `GET /health` — `status: ok`, `database: connected`.
- `GET /api/auth/me` — signed-in office user and server-derived environment.
- `GET /api/releases/capabilities` — `releaseManager` and configuration state.
- `GET /api/releases/fleet` — per-tenant `deployMode`, runtime health, release
  state and rollback eligibility.
- `GET /api/releases` — the catalog.
- Coolify deployment records provide the commit, status and timestamps.

### 7.3 Common issues

| Symptom                                                | Cause / action                                                                                                        |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Releases menu missing                                  | Hard-refresh the page. The live bundle contains it; an old SPA cache can omit it. Confirm the URL is the intended CP. |
| Publish/Upgrade/Rollback disabled                      | The signed-in email is not in `RELEASE_MANAGER_EMAILS`.                                                               |
| Rollback disabled on a Dockerfile tenant               | Expected: legacy Dockerfile tenants need a blue/green migration.                                                      |
| Rollback disabled after a rollback                     | Expected: the current release is the first/rolled-back release with no earlier verified target; use Upgrade.          |
| “No approved stable Store release is registered”       | Publish and register a stable `store` release before onboarding.                                                      |
| “No approved stable Head Office release is registered” | Publish and register a stable `ho` release; production will not fall back to Dockerfile.                              |
| “dockerfile_requires_blue_green”                       | The tenant is a legacy Dockerfile app; perform a blue/green migration.                                                |
| Delete client appears to do nothing                    | The client owns stores, a Head Office or invoices. The server returns `company_in_use`; suspend it instead.           |
| Deployment stuck or lock held                          | Wait for the lock to expire or use the reconcile action; never start a second writer.                                 |

---

## 8. Decision summary

- **New stores:** use the new build-once shared-image path. The store release A
  is registered in both CPs, so a new production store can be provisioned from
  that image today. The first production image onboarding should be treated as
  the acceptance test for GHCR pull access on the production Coolify host.
- **New Head Offices:** use the new shared-image path. The stable Head Office
  release A is registered in both catalogs from the same commit as Store
  release A. The first production multi-store onboarding is the acceptance test
  for the HO image, env injection and GHCR pull access.
- **Existing Dockerfile tenants:** keep them running on the old path. Do not
  convert in place. Migrate blue/green when the tenant is ready.
- **Release B:** remains beta and staging-only. Promote it to `stable` and
  register it in production only after it is accepted for production.
- **M4:** retain until you are satisfied with the permanent CPs, then
  decommission it separately. OptiMed remains untouched.
