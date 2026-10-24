# Marketing Demo Image Migration — 2026-10-23

**Status:** complete on the permanent staging Control Plane
(`staging-cp.vula-app.co.za`). All nine marketing demo Stores and the Urban
Threads Head Office now run the shared ARM64 GHCR images instead of per-tenant
Dockerfile builds. The public URLs, marketing links, demo logins, client
relationships and subscription configuration are unchanged.

The old Dockerfile applications and their volumes were deleted on 2026-10-24,
after every replacement was verified. The golden demo databases used by the
nightly reset remain in `/backups/vula-app/demo-golden/`.

## Result

| Demo                      | Type        | Public URL                                      | New app UUID               | Image   | Login                         | Reset  |
| ------------------------- | ----------- | ----------------------------------------------- | -------------------------- | ------- | ----------------------------- | ------ |
| Demo General Retail       | Store       | `https://demo-general.vula-app.co.za`           | `xxlgl7dhq3js2wg4ju8pgnxr` | Store A | 200, 28 products              | Passed |
| Demo Auto Spares          | Store       | `https://demo-spares.vula-app.co.za`            | `ayouhkwonlzdjmpxqhlisbyo` | Store A | 200, 29 products              | Passed |
| Demo Restaurant           | Store       | `https://demo-restaurant.vula-app.co.za`        | `rwhuwrddzuhvzx1x9fmhb9gw` | Store A | 200, 31 products              | Passed |
| Demo Hardware             | Store       | `https://demo-hardware.vula-app.co.za`          | `immflsogrir2ejloidm41yiy` | Store A | 200, 30 products              | Passed |
| Demo Pharmacy             | Store       | `https://demo-pharmacy.vula-app.co.za`          | `hqgzqt1x9pqwbl2oqhgcffli` | Store A | 200, 27 products              | Passed |
| Demo Stationery           | Store       | `https://demo-stationery.vula-app.co.za`        | `gihprbh91svfabckxl2ntpmj` | Store A | 200, 36 products              | Passed |
| Urban Threads Jhb         | Store       | `https://demo-urban-threads-jhb.vula-app.co.za` | `r7duyq1hlo2otxgpfwv8oig2` | Store A | 200, 30 products              | Passed |
| Urban Threads Cpt         | Store       | `https://demo-urban-threads-cpt.vula-app.co.za` | `hki4r7n2qyatjxvfjjdurmh0` | Store A | 200, 30 products              | Passed |
| Urban Threads Dbn         | Store       | `https://demo-urban-threads-dbn.vula-app.co.za` | `0z6pp7i1isxi6zidocd7yaeq` | Store A | 200, 30 products              | Passed |
| Urban Threads Head Office | Head Office | `https://demo-urban-threads-ho.vula-app.co.za`  | `xjeobzicewspkecs6yijilkj` | HO A    | 200, dashboard + 5 categories | Passed |

`demo-stationery` was not previously in the staging registry. It was added as a
CP-managed demo first: company `Demo Stationery` (id 10, plan 9, paid through
2099-12-31, 2 licensed terminals) and store `Papervale Stationers`
(`demo-stationery`, id 18). Its public URL, login and golden data are unchanged.

Image releases used:

- Store A: `v2026.10.21-5781c2c`,
  `sha256:6db6b974b78c663a42796db9b738cc4ee21bc097bd1f9ba29ea836ef8ef5cb14`
- Head Office A: `v2026.10.21-5781c2c`,
  `sha256:d50f979c3c7a9f1dfdd51928cecf9f29ca6fd01f7dbfb594905b5c34ecb6a9d6`

All ten report `deployMode: image`, `deployStatus: deployed`,
`runtimeHealth: up`, `imageTag: v2026.10.21-5781c2c`.

## How the blue/green migration was done

1. The Control Plane registry was backed up and verified first:
   `vula-cp-staging-pre-demo-migration-20261023.db`,
   `sha256:0def7c5603d1ddca5e254aa3b69f5f7b1445b33075b51181a0246b4736481918`,
   integrity ok, 11 stores / 2 panels / 8 companies.
2. `VULA_DATA_ROOT` was set to `/data/apps/vula-app-image` on the staging CP, so
   every new image app gets a host tree separate from the old
   `/data/apps/vula-app`.
3. For each demo, the registry row was switched to a temporary
   `<slug>-img.vula-app.co.za` URL and provisioned through the CP release
   controller (`action: provision`, stable Store A or HO A). The CP created a
   new Coolify Docker Image application, a new named volume and a new JWT secret.
4. The new volume was bound to its new host path with
   `scripts/vula-bind-storage.sh`, then the matching golden demo database was
   copied in and WAL/SHM files removed.
5. The new app was deployed and verified on the temporary URL: `/health` exact
   version/revision/database, demo login, and sample data.
6. The old app was stopped and its domain removed. Only then was the public
   domain moved to the new app and `APP_URL` updated. The registry row was
   restored to the public URL.
7. The public URL was verified again. The old app and its volume were left
   stopped/intact for rollback.

## Reset

`scripts/vula-demo-reset.sh` (installed at
`/usr/local/bin/vula-demo-reset.sh`, cron `/etc/cron.d/vula-demo-reset` at
02:17) now maps the new app UUIDs and the new image host tree:

- stores: `/data/apps/vula-app-image/clients/<client>/stores/<slug>/za-pos.db`
- Head Office: `/data/apps/vula-app-image/clients/urban-threads-demo/head-office/head-office.db`

The script was run immediately after the migration for every demo; all ten
reset successfully and re-verified login and sample data, including
`demo-stationery`.

## Rollback

The old Dockerfile applications, their volumes and their old host directories
were deleted on 2026-10-24 after all ten replacements passed. They are no longer
available as a rollback target.

If a replacement demo has to be rolled back now:

1. Use the pre-migration registry backup
   `vula-cp-staging-pre-demo-migration-20261023.db` for the old registry rows.
2. Re-seed the demo from its golden database in
   `/backups/vula-app/demo-golden/`.
3. If a release is faulty, publish or register a corrected image release and
   apply it through the Control Plane; do not expect a Dockerfile app to exist.

Historical old app UUIDs (deleted): `cfpit8t3c3qpx0ldnf8qdzik`,
`tyzt97d9cwn467kgog5g9tep`, `3ryq7svgewjdm9trxtk3d9jq`,
`lqu4n6fxk0he5b6royou8j5x`, `aux8ftmmtzooxmavwk2a0mjj`,
`fnz1en1dirrup5we6yfruar1`, `q20lwe1nrfxljrjfxn07fnq5`,
`ojcdtrzyhwripfxcwmarffqd`, `jeqhdcsmaiecvd0r72ecnxet`,
`cpnsg0e0lw3ggr07os8bknzg`.
