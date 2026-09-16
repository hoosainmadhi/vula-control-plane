/**
 * Seed the registry with a management-demo fleet: two real clients, their Head
 * Office panels, and every one of their branches, on a production-looking URL
 * scheme.
 *
 * Why a seeder rather than the UI: a convincing demo needs forty-nine branches
 * that already look like a working fleet — each one deployed, configured,
 * licensed, healthy and reporting telemetry — and clicking that together by hand
 * is neither quick nor repeatable. This writes the whole shape in one pass.
 *
 * It writes DIRECTLY to the registry (`getRegistryDb()`), not over the HTTP API.
 * Every value here is a registry column the office routes would only re-derive,
 * and none of it should depend on the control plane being up. That also means it
 * reads `CP_DB_PATH` the same way the server does — so point it at a scratch
 * file, NEVER at the live registry:
 *
 *   CP_DB_PATH=/tmp/mockup-fleet.db npx tsx scripts/seed-mockup-fleet.ts --dry-run
 *   CP_DB_PATH=/tmp/mockup-fleet.db npx tsx scripts/seed-mockup-fleet.ts
 *
 * Idempotent by slug: a client, panel or store that already exists is skipped and
 * reported, so it can be re-run as the demo grows. `--force` updates the key
 * fields of what it finds instead of skipping. It refuses to touch a registry
 * holding companies, panels or stores it does not manage unless `--force` is
 * given — and `--force` still leaves those rows alone.
 *
 * Opening the registry runs the schema DDL and the plan seed, so even a
 * `--dry-run` against a fresh path creates an empty registry with its seeded plan
 * catalogue. Nothing client-shaped is written until the seeding phase.
 */
import crypto from 'crypto';
import {
  STORE_VERTICALS,
  createCompany,
  createPanel,
  createStore,
  getCompanyBySlug,
  getPanelBySlug,
  getPlanByCode,
  getRegistryDb,
  getStoreBySlug,
  listCompanies,
  listPanels,
  listStores,
  nextLicenceSequence,
  nextPanelLicenceSequence,
  recordConfigResult,
  recordHealthResult,
  recordLicencePush,
  recordPanelHealth,
  recordPanelLicencePush,
  recordTelemetry,
  setAllocation,
  setLicensedTerminalCount,
  setPanelDeployStatus,
  setSetupFeeStatus,
  setStoreCompany,
  setStoreDeployStatus,
  updateCompany,
  updatePanel,
  updateStore,
  type StoreVertical,
} from '../src/config/registryDb.js';

// --- Constants ---------------------------------------------------------------

/** The demo's public wildcard: every fleet member answers on its own subdomain. */
const HOST = 'ultraposai.compubyte.co.za';

/** A store and a Head Office are both addressed by slug, on the same host. */
const storeUrl = (slug: string): string => `https://${slug}.${HOST}/`;
const panelUrl = (slug: string): string => `https://${slug}.${HOST}/`;

/** The POS build the demo fleet runs — matches the current tenant release. */
const APP_VERSION = '0.8.0 ui-r11';
/** The tenant's SQLite `user_version`: the schema generation that build expects. */
const SCHEMA_VERSION = 7;

/**
 * The fleet is a production fleet, so it is registered as one — this is the
 * environment the SPOG buckets versions and health by, not a deployment switch.
 */
const ENVIRONMENT = 'production' as const;

/**
 * Paid up well past the register's warn window (`REGISTER_WARN_DAYS = 7`), so
 * every store derives `active` and reads `ok` rather than throwing an amber
 * "renewal due" the demo would have to explain away.
 */
const PAID_THROUGH_DAYS = 45;

/** The same resolution `src/config/env.ts` uses: CP_DB_PATH > DB_PATH > data/. */
const REGISTRY_PATH = process.env.CP_DB_PATH || process.env.DB_PATH || 'data/control-plane.db';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const FORCE = args.includes('--force');

// --- The fleet ---------------------------------------------------------------

interface BranchSpec {
  /** Display name, as the branch is known. */
  name: string;
  /** Registry slug — also the deployment's subdomain. */
  slug: string;
}

interface ClientSpec {
  slug: string;
  name: string;
  billingEmail: string;
  /** Must exist in the registry's seeded catalogue. */
  planCode: string;
  panel: { slug: string; name: string };
  vertical: StoreVertical;
  /** Tills every one of this client's stores is configured for. */
  tillsPerStore: number;
  branches: BranchSpec[];
}

/**
 * Two clients, deliberately different shapes: a forty-one branch spares network
 * on a 50-store plan with 3 tills each, and an eight branch retail brand on a
 * 10-store plan with 2. Between them they exercise the fleet list, the client
 * drill-down, licence allocations and the fleet-wide pages without a single row
 * looking like a fixture.
 */
const CLIENTS: ClientSpec[] = [
  {
    slug: 'ahk-spares',
    name: 'AHK Spares',
    billingEmail: 'ops@ahk-spares.co.za',
    planCode: 'vula-spares-network',
    panel: { slug: 'ahk-spares-ho', name: 'AHK Spares Head Office' },
    vertical: 'spares',
    tillsPerStore: 3,
    branches: [
      { name: 'Atteridgeville', slug: 'ahk-atteridgeville' },
      { name: 'Boksburg', slug: 'ahk-boksburg' },
      { name: 'Brakpan', slug: 'ahk-brakpan' },
      { name: 'Daveyton', slug: 'ahk-daveyton' },
      { name: 'Fordsburg', slug: 'ahk-fordsburg' },
      { name: 'Hammanskraal', slug: 'ahk-hammanskraal' },
      { name: 'Heidelberg', slug: 'ahk-heidelberg' },
      { name: 'Industria West', slug: 'ahk-industria-west' },
      { name: 'Kwa-Thema', slug: 'ahk-kwa-thema' },
      { name: 'Lenasia', slug: 'ahk-lenasia' },
      { name: 'Meyerton', slug: 'ahk-meyerton' },
      { name: 'Randfontien', slug: 'ahk-randfontein' },
      { name: 'Randburg', slug: 'ahk-randburg' },
      { name: 'Selby', slug: 'ahk-selby' },
      { name: 'Soshanguve', slug: 'ahk-soshanguve' },
      { name: 'Springs', slug: 'ahk-springs' },
      { name: 'Turffontein', slug: 'ahk-turffontein' },
      { name: 'Vanderbijlpark', slug: 'ahk-vanderbijlpark' },
      { name: 'Vereeniging', slug: 'ahk-vereeniging' },
      { name: 'ALRODE', slug: 'ahk-alrode' },
      { name: 'DE DEUR', slug: 'ahk-de-deur' },
      { name: 'THREE RIVERS', slug: 'ahk-three-rivers' },
      { name: 'Bloemfontein', slug: 'ahk-bloemfontein' },
      { name: 'Delmas', slug: 'ahk-delmas' },
      { name: 'Witbank', slug: 'ahk-witbank' },
      { name: 'Klerksdorp', slug: 'ahk-klerksdorp' },
      { name: 'Potchefstroom', slug: 'ahk-potchefstroom' },
      { name: 'Rustenburg', slug: 'ahk-rustenburg' },
      { name: 'Eerste River', slug: 'ahk-eerste-river' },
      { name: 'George', slug: 'ahk-george' },
      { name: 'Grassy Park', slug: 'ahk-grassy-park' },
      { name: 'Kensington', slug: 'ahk-kensington' },
      { name: 'Kuils River', slug: 'ahk-kuils-river' },
      { name: 'Lansdowne', slug: 'ahk-lansdowne' },
      { name: 'Parow', slug: 'ahk-parow' },
      { name: 'Philippi', slug: 'ahk-philippi' },
      { name: 'Retreat', slug: 'ahk-retreat' },
      { name: 'Rylands', slug: 'ahk-rylands' },
      { name: 'PAARL', slug: 'ahk-paarl' },
      { name: 'BOTHASIG', slug: 'ahk-bothasig' },
      { name: 'PORTLANDS', slug: 'ahk-portlands' },
    ],
  },
  {
    slug: 'street-gym',
    name: 'Street Gym',
    billingEmail: 'ops@streetgym.co.za',
    planCode: 'vula-market-plus',
    panel: { slug: 'street-gym-ho', name: 'Street Gym Head Office' },
    vertical: 'general',
    tillsPerStore: 2,
    branches: [
      { name: 'S&K Southgate', slug: 'street-gym-sk-southgate' },
      { name: 'S&K Maponya', slug: 'street-gym-sk-maponya' },
      { name: 'S&K Trade Route Mall', slug: 'street-gym-sk-trade-route' },
      { name: 'Street Gym Carlton Centre', slug: 'street-gym-carlton-centre' },
      { name: 'Street Gym Maponya', slug: 'street-gym-maponya' },
      { name: 'Street Gym Protea Glen', slug: 'street-gym-protea-glen' },
      { name: 'Street Gym Springs', slug: 'street-gym-springs' },
      { name: 'Street Gym Westgate', slug: 'street-gym-westgate' },
    ],
  },
];

// --- Small helpers -----------------------------------------------------------

const fail = (message: string): never => {
  console.error(`\nseed-mockup-fleet failed: ${message}`);
  process.exit(1);
};

/** A fresh push credential. The registry keeps it; no API ever returns it. */
const newControlPlaneToken = (): string => crypto.randomBytes(32).toString('hex');

/** A date `days` ahead, in the `YYYY-MM-DD` form `paid_through` stores. */
const daysFromNow = (days: number): string =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

const minutesAgo = (minutes: number): string =>
  new Date(Date.now() - minutes * 60_000).toISOString();

/**
 * A stable hardware-shaped id for a claimed till. Derived from the store and
 * till number rather than generated, so re-running the seeder does not rewrite
 * every device's identity in the demo.
 */
const deviceIdFor = (storeSlug: string, till: number): string =>
  crypto.createHash('sha1').update(`${storeSlug}:${till}`).digest('hex').slice(0, 16);

const assertVertical = (value: string): StoreVertical => {
  if (!(STORE_VERTICALS as readonly string[]).includes(value)) {
    throw new Error(`Unknown store vertical '${value}'`);
  }
  return value as StoreVertical;
};

// --- What a live store looks like --------------------------------------------

/**
 * The configure response the store would have sent back, stored verbatim as the
 * registry's config snapshot. `terminalsFor()` in `routes/stores.ts` reads
 * `applied.terminalCount` to decide which tills show as configured, so it has to
 * carry the store's real till count or the roster renders half-configured.
 */
const configSnapshot = (tills: number) => ({
  ok: true,
  applied: {
    terminalCount: tills,
    terminals: Array.from({ length: tills }, (_, i) => ({ till: i + 1, name: `Till ${i + 1}` })),
  },
});

/**
 * A telemetry snapshot in the v0.4.0 contract shape. `lastSyncAt` is real and
 * recent, which is what makes the store read as live; `pendingEvents`,
 * `failedEvents` and per-till `lastSeenAt` are the fields the tenant has not
 * shipped yet, so they stay null exactly as a real store reports them — inventing
 * numbers there would put a sync queue on screen that no deployment has.
 */
const telemetrySnapshot = (slug: string, tills: number, ageMinutes: number) => {
  const generatedAt = minutesAgo(ageMinutes);
  return {
    ok: true,
    app: 'vula',
    version: APP_VERSION,
    environment: ENVIRONMENT,
    schemaVersion: SCHEMA_VERSION,
    generatedAt,
    sync: { lastSyncAt: generatedAt, pendingEvents: null, failedEvents: null },
    terminals: Array.from({ length: tills }, (_, i) => ({
      till: i + 1,
      name: `Till ${i + 1}`,
      claimed: true,
      deviceId: deviceIdFor(slug, i + 1),
      sessionOpen: i === 0,
      lastSeenAt: null,
    })),
  };
};

/**
 * Make one store look like something that has been running for a while:
 * configured, licensed, healthy, reporting telemetry and deployed.
 *
 * This is the entire point of the mockup. A registry of bare rows with no config,
 * no licence and no heartbeat renders as a fleet of grey unknowns, which
 * demonstrates nothing an operator would recognise.
 *
 * A store that already exists keeps its Coolify identity on a `--force` re-run:
 * the uuid and volume name are what a retry would otherwise duplicate, and they
 * are not the seeder's to churn.
 */
const makeStoreLookAlive = (
  storeId: number,
  slug: string,
  tills: number,
  isNew: boolean,
  ageMinutes: number,
): void => {
  recordConfigResult(storeId, { status: 'ok', snapshot: configSnapshot(tills) });
  nextLicenceSequence(storeId);
  recordLicencePush(storeId, 'ok');
  recordHealthResult(storeId, 'up');
  const telemetry = telemetrySnapshot(slug, tills, ageMinutes);
  recordTelemetry(storeId, {
    version: APP_VERSION,
    schemaVersion: SCHEMA_VERSION,
    generatedAt: telemetry.generatedAt,
    telemetry,
  });
  setStoreDeployStatus(
    storeId,
    'deployed',
    isNew ? { coolifyUuid: crypto.randomUUID(), volumeName: `vula-${slug}-data` } : {},
  );
};

/** The same, for a Head Office: deployed, healthy, and holding a licence. */
const makePanelLookAlive = (panelId: number, slug: string, isNew: boolean): void => {
  recordPanelHealth(panelId, 'up', APP_VERSION);
  nextPanelLicenceSequence(panelId);
  recordPanelLicencePush(panelId, 'ok');
  setPanelDeployStatus(
    panelId,
    'deployed',
    isNew ? { coolifyUuid: crypto.randomUUID(), volumeName: `vula-${slug}-data` } : {},
  );
};

// --- Seeding -----------------------------------------------------------------

const licensedTotalFor = (spec: ClientSpec): number => spec.branches.length * spec.tillsPerStore;

const main = (): void => {
  // Opening the registry runs the schema DDL and the plan seed, so the catalogue
  // below is guaranteed to exist on a fresh database.
  getRegistryDb();

  // 1. Resolve the plans the clients are being put on. A missing code means this
  //    is not the registry we think it is, so refuse rather than create a
  //    company pointing at nothing.
  const planIdByCode = new Map<string, number>();
  for (const spec of CLIENTS) {
    if (planIdByCode.has(spec.planCode)) continue;
    const plan = getPlanByCode(spec.planCode);
    if (!plan) {
      return fail(
        `plan '${spec.planCode}' is not in the catalogue at ${REGISTRY_PATH}. ` +
          'Point CP_DB_PATH at a fresh registry and re-run.',
      );
    }
    planIdByCode.set(spec.planCode, plan.id);
  }

  // 2. Refuse to work in a registry that already holds a fleet this script does
  //    not manage — its rows are somebody else's demo, and `--force` only ever
  //    adds to them, never rewrites or removes them.
  const managedCompanies = new Set(CLIENTS.map((c) => c.slug));
  const managedPanels = new Set(CLIENTS.map((c) => c.panel.slug));
  const managedStores = new Set(CLIENTS.flatMap((c) => c.branches.map((b) => b.slug)));

  const foreign = [
    ...listCompanies()
      .filter((c) => !managedCompanies.has(c.slug))
      .map((c) => `client ${c.slug}`),
    ...listPanels()
      .filter((p) => !managedPanels.has(p.slug))
      .map((p) => `panel ${p.slug}`),
    ...listStores()
      .filter((s) => !managedStores.has(s.slug))
      .map((s) => `store ${s.slug}`),
  ];
  if (foreign.length > 0 && !FORCE) {
    console.error(
      `Refusing: ${REGISTRY_PATH} holds ${foreign.length} row(s) this script does not manage:`,
    );
    for (const row of foreign.slice(0, 12)) console.error(`  ${row}`);
    if (foreign.length > 12) console.error(`  … and ${foreign.length - 12} more`);
    console.error('Re-run with --force to seed alongside them and leave them untouched.');
    process.exit(1);
  }

  const totalBranches = CLIENTS.reduce((n, c) => n + c.branches.length, 0);
  const totalLicensed = CLIENTS.reduce((n, c) => n + licensedTotalFor(c), 0);

  console.log(
    `Registry: ${REGISTRY_PATH}${DRY_RUN ? '   (dry run — nothing will be written)' : ''}`,
  );
  console.log(`\nClients (${CLIENTS.length}) and the fleet they are licensed for:`);
  for (const spec of CLIENTS) {
    console.log(
      `  ${spec.name.padEnd(14)} ${spec.planCode.padEnd(22)} ` +
        `${String(spec.branches.length).padStart(2)} branches · ` +
        `${String(licensedTotalFor(spec)).padStart(3)} licensed terminals · ` +
        `${spec.tillsPerStore} tills/store`,
    );
  }
  console.log(
    `  ${'TOTAL'.padEnd(14)} ${' '.padEnd(22)} ` +
      `${String(totalBranches).padStart(2)} branches · ${String(totalLicensed).padStart(3)} licensed terminals`,
  );

  if (DRY_RUN) {
    for (const spec of CLIENTS) {
      console.log(`\n${spec.name} — ${spec.panel.name} (${panelUrl(spec.panel.slug)})`);
      for (const branch of spec.branches) {
        console.log(
          `  ${branch.slug.padEnd(28)} ${branch.name.padEnd(26)} ` +
            `${spec.vertical.padEnd(7)} ${spec.tillsPerStore} tills  ${storeUrl(branch.slug)}`,
        );
      }
    }
    console.log('\n--dry-run: nothing written.');
    return;
  }

  const vertical = assertVertical;

  let createdStores = 0;
  let updatedStores = 0;
  let skippedStores = 0;

  for (const spec of CLIENTS) {
    const planId = planIdByCode.get(spec.planCode);
    if (planId === undefined) return fail(`no plan id resolved for '${spec.planCode}'`);
    const licensed = licensedTotalFor(spec);
    const paidThrough = daysFromNow(PAID_THROUGH_DAYS);

    console.log(`\n${spec.name} — ${spec.panel.name}`);

    // --- Client --------------------------------------------------------------
    const existingCompany = getCompanyBySlug(spec.slug);
    let companyId: number;
    if (existingCompany) {
      companyId = existingCompany.id;
      if (FORCE) {
        updateCompany(companyId, {
          name: spec.name,
          billingEmail: spec.billingEmail,
          planId,
          paidThrough,
        });
        console.log(`  ✓ client ${spec.name} — updated (${spec.planCode})`);
      } else {
        console.log(`  · client ${spec.name} — already present`);
      }
    } else {
      companyId = createCompany({
        name: spec.name,
        slug: spec.slug,
        billingEmail: spec.billingEmail,
        planId,
        paidThrough,
      }).id;
      console.log(`  ✓ client ${spec.name} (${spec.planCode})`);
    }
    // The purchased quantity and the onboarding charge are facts about the
    // subscription, not the company, so they are written every run: a client
    // whose allocations were edited still has to cover the fleet below.
    setLicensedTerminalCount(companyId, licensed);
    setSetupFeeStatus(companyId, 'paid');

    // --- Head Office ---------------------------------------------------------
    const existingPanel = getPanelBySlug(spec.panel.slug);
    let panelId: number;
    let panelIsNew = false;
    if (existingPanel) {
      panelId = existingPanel.id;
      if (FORCE) {
        updatePanel(panelId, {
          name: spec.panel.name,
          baseUrl: panelUrl(spec.panel.slug),
        });
        console.log(`  ✓ panel ${spec.panel.slug} — updated`);
      } else {
        console.log(`  · panel ${spec.panel.slug} — already present`);
      }
    } else {
      panelId = createPanel({
        companyId,
        slug: spec.panel.slug,
        name: spec.panel.name,
        baseUrl: panelUrl(spec.panel.slug),
        controlPlaneToken: newControlPlaneToken(),
      }).id;
      panelIsNew = true;
      console.log(`  ✓ panel ${spec.panel.slug}`);
    }
    if (panelIsNew || FORCE) makePanelLookAlive(panelId, spec.panel.slug, panelIsNew);

    // --- Branches ------------------------------------------------------------
    // One minute of drift between stores, so the fleet's heartbeats are spread
    // across a few minutes rather than all landing on the same second.
    let ageMinutes = 2;
    for (const branch of spec.branches) {
      const existingStore = getStoreBySlug(branch.slug);
      let storeId: number;
      let storeIsNew = false;

      if (existingStore && !FORCE) {
        console.log(`  · ${branch.slug} — already present`);
        skippedStores += 1;
        continue;
      }

      if (existingStore) {
        storeId = existingStore.id;
        updateStore(storeId, {
          name: branch.name,
          vertical: vertical(spec.vertical),
          terminalCount: spec.tillsPerStore,
          baseUrl: storeUrl(branch.slug),
          environment: ENVIRONMENT,
        });
        console.log(`  ✓ ${branch.slug} — updated`);
        updatedStores += 1;
      } else {
        storeId = createStore(
          {
            name: branch.name,
            slug: branch.slug,
            vertical: vertical(spec.vertical),
            terminalCount: spec.tillsPerStore,
            baseUrl: storeUrl(branch.slug),
            environment: ENVIRONMENT,
          },
          newControlPlaneToken(),
        ).id;
        storeIsNew = true;
        console.log(`  ✓ ${branch.slug}`);
        createdStores += 1;
      }

      // Link, allocate, then make it look alive. Order matters: the store's
      // licence allowance is its allocation, and the licence is what the
      // register gates new device claims on.
      setStoreCompany(storeId, companyId);
      setAllocation(companyId, storeId, spec.tillsPerStore);
      makeStoreLookAlive(storeId, branch.slug, spec.tillsPerStore, storeIsNew, ageMinutes);
      ageMinutes = ageMinutes >= 9 ? 2 : ageMinutes + 1;
    }
  }

  // --- Verify ----------------------------------------------------------------
  // A ✓ printed over a row that did not land would be worse than no output at
  // all, so the expected slugs are read back before the summary is trusted.
  const missing = CLIENTS.flatMap((c) => c.branches.map((b) => b.slug)).filter(
    (slug) => getStoreBySlug(slug) === null,
  );
  if (missing.length > 0) {
    return fail(`these stores did not land in the registry: ${missing.join(', ')}`);
  }
  const unlinked = CLIENTS.flatMap((c) =>
    c.branches.filter((b) => getStoreBySlug(b.slug)?.company_id === null).map((b) => b.slug),
  );
  if (unlinked.length > 0) {
    return fail(`these stores have no client: ${unlinked.join(', ')}`);
  }

  // --- Summary ---------------------------------------------------------------
  console.log('\nSummary');
  console.log('─'.repeat(74));
  for (const spec of CLIENTS) {
    console.log(
      `  ${spec.name.padEnd(14)} ${String(spec.branches.length).padStart(2)} stores · ` +
        `${String(licensedTotalFor(spec)).padStart(3)} licensed terminals · ` +
        `1 Head Office (${spec.panel.slug})`,
    );
  }
  console.log(
    `  ${'TOTAL'.padEnd(14)} ${String(totalBranches).padStart(2)} stores · ` +
      `${String(totalLicensed).padStart(3)} licensed terminals · ${CLIENTS.length} Head Offices`,
  );
  console.log(
    `\n  clients: ${CLIENTS.length} · panels: ${CLIENTS.length} · ` +
      `stores created: ${createdStores} · updated: ${updatedStores} · already present: ${skippedStores}`,
  );
  console.log(
    `  All ${totalBranches} stores are on ${APP_VERSION}, schema ${SCHEMA_VERSION}, deployed and healthy.`,
  );
};

main();
