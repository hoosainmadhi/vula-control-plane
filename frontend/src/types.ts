// Wire types mirroring the control-plane API (src/routes/stores.ts).

export type StoreStatus = 'active' | 'paused';
export type ConfigStatus = 'pending' | 'ok' | 'failed';
export type HealthStatus = 'up' | 'down' | 'unknown';
export type StoreVertical =
  'general' | 'clothing' | 'spares' | 'hardware' | 'pharmacy' | 'restaurant' | 'custom';

export type PlanPeriod = 'monthly' | 'annual' | 'once-off';

/** How a plan charges: a rate per licensed terminal, or a negotiated deal. */
export type PricingMode = 'per_terminal' | 'custom';

export interface Plan {
  id: number;
  code: string;
  name: string;
  /** Store-count cap. */
  maxStores: number;
  /** Entitlement limit per store — NOT a configured/claimed till count. */
  maxTerminalsPerStore: number;
  features: string[];
  pricingMode: PricingMode;
  /** Rate per licensed terminal per billing period (0 on a custom plan). */
  terminalPriceCents: number;
  /**
   * A custom plan's agreed charge per billing period. 0 means "negotiated per
   * client": invoices then need an explicit amount.
   */
  customAmountCents: number;
  /** Once-off onboarding charge for the client. */
  setupFeeCents: number;
  /** How the price recurs — 'once-off' is a perpetual licence, not a subscription. */
  billingPeriod: PlanPeriod;
  isActive: boolean;
  createdAt: string;
}

export type SetupFeeStatus = 'not_invoiced' | 'invoiced' | 'paid' | 'waived';

/** What a client purchased, priced — the subscription behind its plan. */
export interface Subscription {
  licensedTerminalCount: number;
  allocatedTerminals: number;
  unallocatedTerminals: number;
  /** null when the plan is custom-priced (or absent) — never a guessed figure. */
  recurringAmountCents: number | null;
  rateCents: number;
  setupFeeCents: number;
  setupFeeStatus: SetupFeeStatus;
  /** The once-off charge still to be raised (0 once invoiced, paid or waived). */
  setupFeeDueCents: number;
  /** The document carrying it, when it has been billed (e.g. INV-20260916-1553). */
  setupFeeRef: string | null;
  allocations: Array<{ storeId: number; licensedTerminalCount: number }>;
}

export type BillingState = 'active' | 'trial' | 'past_due' | 'suspended' | 'unlicensed';

/**
 * How the register presents the subscription (L4). Derived by the control plane
 * from the same inputs the licence carries; the register derives the same states
 * from its licence.
 */
export type RegisterState = 'ok' | 'warn' | 'grace' | 'suspended' | 'trial' | 'unlicensed';

export interface Company {
  id: number;
  name: string;
  slug: string;
  billingEmail: string;
  planId: number | null;
  planCode: string;
  planName: string;
  paidThrough: string | null;
  trialEndsAt: string | null;
  /** Operator override: active or manually suspended. Distinct from billing state. */
  status: 'active' | 'suspended';
  billingState: BillingState;
  storesUsed: number;
  maxStores: number;
  maxTerminalsPerStore: number;
  features: string[];
  panels: number;
  note: string;
  /** How the register will present the subscription. */
  registerState: RegisterState;
  /** True when the register refuses new sales for this company. */
  tradingBlocked: boolean;
  /** The purchased quantity and what it costs. */
  subscription: Subscription;
  createdAt: string;
}

/** Feature keys a plan can grant. Kept in step with the store-side gate list. */
export const FEATURE_KEYS = [
  'customer_credit',
  'advanced_reports',
  'multi_store',
  'stock_transfers',
  'ecommerce_bridges',
  'ai_assistant',
] as const;

export interface Panel {
  id: number;
  companyId: number;
  companyName: string;
  slug: string;
  name: string;
  baseUrl: string;
  status: StoreStatus;
  lastHealthStatus: HealthStatus;
  lastHealthAt: string | null;
  appVersion: string | null;
  licenceSequence: number;
  licenceIssuedAt: string | null;
  licencePushStatus: ConfigStatus;
  licencePushedAt: string | null;
  planCode: string;
  planName: string;
  billingState: string;
  createdAt: string;
}

export interface PanelPushOutcome {
  ok: boolean;
  sequence?: number;
  error?: string;
}

export type StoreEnvironment = 'production' | 'staging' | 'demo' | 'development';

/** Operator-facing technical health vocabulary (SPOG §9). */
export type HealthState = 'healthy' | 'warning' | 'degraded' | 'offline' | 'unknown';

/** Versioned configuration state (SPOG §12). */
export type ConfigState = 'current' | 'pending' | 'failed' | 'unknown';

export interface Store {
  id: number;
  slug: string;
  name: string;
  terminalNames: string[];
  lastConfigError?: string | null;
  lastHealthError?: string | null;
  environment: StoreEnvironment;
  healthState: HealthState;
  configState: ConfigState;
  configVersion: { expected: number; applied: number };
  latencyMs?: number | null;
  appVersion?: string | null;
  schemaVersion?: number | null;
  lastHeartbeatAt?: string | null;
  telemetry?: {
    version: string | null;
    generatedAt: string | null;
    sync: { lastSyncAt: string | null; pendingEvents: number | null; failedEvents: number | null };
    terminals: { configured: number; claimed: number; open: number; online: number };
  } | null;
  vertical: StoreVertical;
  /** Terminal slots this store is configured to run (pushed as Till 1..N). */
  terminalCount: number;
  /** Terminal licences this store holds — what its signed licence permits. */
  licensedTerminalCount: number;
  baseUrl: string;
  status: StoreStatus;
  lastConfigStatus: ConfigStatus;
  lastConfigAt: string | null;
  lastHealthAt: string | null;
  lastHealthStatus: HealthStatus;
  licenceSequence: number;
  licenceIssuedAt: string | null;
  licencePushStatus: ConfigStatus;
  licencePushedAt: string | null;
  companyId: number | null;
  companyName: string;
  planCode: string;
  planName: string;
  billingState: string;
  entitlementNote: string;
  /** How the register will present the subscription. */
  registerState: RegisterState;
  /** True when the register refuses new sales for this store's company. */
  tradingBlocked: boolean;
  deployStatus?: 'not_deployed' | 'provisioning' | 'deployed' | 'failed';
  coolifyUuid?: string | null;
  adminEmail?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TerminalPreview {
  till: number;
  name: string;
  configured: boolean;
}

export interface StoreDetail extends Store {
  lastConfigSnapshot: unknown;
  terminals: TerminalPreview[];
}

export interface PushOutcome {
  ok: boolean;
  lastConfigStatus: 'ok' | 'failed';
  pushedAt: string | null;
  snapshot?: unknown;
  error?: string;
}

export interface HealthOutcome {
  ok: boolean;
  healthStatus: 'up' | 'down';
  checkedAt: string | null;
  detail?: unknown;
  error?: string;
}

export interface LoginResponse {
  token: string;
  user: { email: string; role: 'office' };
}

export interface CreateStoreResponse {
  store: Store;
  firstPush: PushOutcome | null;
  provisioning?: boolean;
  /**
   * Present only when the control plane generated the token. Shown once so the
   * operator can install it in the deployment's env; never returned again.
   */
  generatedControlPlaneToken?: string;
}

export interface ResetAdminResponse {
  ok: boolean;
  tempPassword: string;
  note: string;
}

export interface StoreFormValues {
  name: string;
  slug: string;
  vertical: StoreVertical;
  environment?: StoreEnvironment;
  /** Per-till names; '' reverts that till to its "Till N" default. */
  tillNames?: string[];
  baseUrl: string;
  terminalCount: string;
  controlPlaneToken: string;
  /** Merchant this store belongs to; '' = unassigned. */
  companyId: string;
  provision?: boolean;
  adminEmail?: string;
}

export interface Invoice {
  id: number;
  companyId: number;
  companyName: string;
  invoiceNumber: string;
  amountCents: number;
  /** Licensed terminals on the recurring line; null on a manually-priced invoice. */
  terminalCount: number | null;
  /** The per-terminal rate when the invoice was raised (a snapshot). */
  terminalPriceCents: number | null;
  /** Once-off onboarding charge when this invoice carried it. */
  setupFeeCents: number | null;
  /** What the charge is for — required on a hand-priced invoice. */
  description: string | null;
  /** The plan at the time of issue — a snapshot, not today's catalogue entry. */
  planCode: string | null;
  planName: string | null;
  /** The VAT split of `amountCents`, which is VAT-inclusive. Null on invoices
   *  raised before the split existed. */
  subtotalCents: number | null;
  vatCents: number | null;
  vatRate: number | null;
  status: 'pending' | 'paid' | 'overdue' | 'cancelled';
  dueDate: string | null;
  paidDate: string | null;
  /** When the invoice was last emailed to the client (null = never sent). */
  emailedAt: string | null;
  emailedTo: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The control plane's own settings — office identity and the mailer. */
export interface OfficeSettings {
  officeName: string;
  officeEmail: string;
  officePhone: string;
  officeAddress: string;
  /** Payment terms applied to newly raised invoices. */
  invoiceDueDays: number;
  invoiceFooter: string;
  /** The office's own VAT registration ('' = not registered). */
  vatRegNo: string;
  /** The rate its VAT-inclusive prices are quoted at. */
  vatRate: number;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  /** Always the mask on read; sending it back leaves the stored password alone. */
  smtpPass: string;
  smtpFrom: string;
  smtpConfigured: boolean;
  updatedAt: string;
}

export interface Payment {
  id: number;
  invoiceId: number;
  companyId: number;
  amountCents: number;
  method: string;
  status: string;
  transactionId: string | null;
  createdAt: string;
}

export interface BillingSettings {
  companyId: number;
  autoRenew: boolean;
  emailInvoice: boolean;
  invoiceEmail: string;
}

export interface ClientListItem {
  id: number;
  name: string;
  slug: string;
  billingEmail: string;
  topology: 'single_store' | 'multi_store';
  planId: number | null;
  planCode: string;
  planName: string;
  billingState: string;
  paidThrough: string | null;
  trialEndsAt: string | null;
  status: 'active' | 'suspended';
  headOffice: {
    id: number;
    name: string;
    slug: string;
    baseUrl: string;
    health: string;
    appVersion: string | null;
  } | null;
  storesCount: number;
  healthyStoresCount: number;
  /** Configured terminal slots across the client's stores. */
  totalTills: number;
  /** Purchased terminal licences — the billable quantity. */
  licensedTerminalCount: number;
  allocatedTerminals: number;
  recurringAmountCents: number | null;
  setupFeeCents: number;
  setupFeeStatus: SetupFeeStatus;
  latestJobStatus: string | null;
  /** Light store rows so the client card links straight into each store. */
  stores: Array<{
    id: number;
    name: string;
    slug: string;
    environment: StoreEnvironment;
    healthState: HealthState;
  }>;
  createdAt: string;
}

export interface DeploymentJobStep {
  id: number;
  job_id: number;
  step_key: string;
  resource_type: string;
  resource_id: number | null;
  status: 'pending' | 'running' | 'complete' | 'failed' | 'skipped';
  attempts: number;
  error: string | null;
  /** Best-effort operations that did not succeed; the step still completed. */
  warnings_json: string | null;
  metadata_json: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export interface DeploymentJob {
  id: number;
  type: string;
  company_id: number;
  status: 'pending' | 'running' | 'complete' | 'failed';
  error: string | null;
  started_at: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  steps?: DeploymentJobStep[];
}

/** The client detail surface: what a client pays, plan by plan and store by store. */
export interface ClientSubscriptionDetail {
  planId: number | null;
  pricingMode: PricingMode | 'none';
  rateCents: number;
  billingPeriod: PlanPeriod | null;
  licensedTerminalCount: number;
  allocatedTerminals: number;
  unallocatedTerminals: number;
  recurringAmountCents: number | null;
  initialInvoiceTotalCents: number | null;
  setupFeeCents: number;
  setupFeeStatus: SetupFeeStatus;
  setupFeeDueCents: number;
  /** The document carrying the charge, when it has been billed. */
  setupFeeRef: string | null;
  /** Where the price comes from: the client's agreement, or the plan in force. */
  pricingSource: 'agreed' | 'plan' | 'none';
  pricedAt: string | null;
  /** Extra terminals bought mid-period, and what the rest of the period is worth. */
  midPeriodCharge: {
    extraTerminals: number;
    amountCents: number;
    daysRemaining: number;
    periodDays: number;
    from: string;
    to: string;
    /** The invoice already carrying it for this period, if any. */
    billedOn: string | null;
  } | null;
  note: string;
  allocations: Array<{
    storeId: number;
    storeName: string;
    storeSlug: string;
    /** Terminal slots that store is configured to run. */
    terminalCount: number;
    licensedTerminalCount: number;
  }>;
}

export interface ClientDetailResponse {
  client: ClientListItem;
  /** What the client purchased, priced (present on the client detail endpoint). */
  subscription?: ClientSubscriptionDetail;
  headOffice: Panel | null;
  /** Full SPOG store rows (same shape as GET /api/stores). */
  stores: Store[];
  latestDeployment: {
    job: DeploymentJob;
    steps: DeploymentJobStep[];
  } | null;
}

// --- Error feed (§30 observability) ------------------------------------------

/** Which subsystem failed. */
export type ErrorSource = 'health' | 'config' | 'licence' | 'deploy';

/**
 * One distinct fault with its occurrences folded in. `message` is the most
 * recent occurrence's text, so the row reads as the fault looks now.
 */
export interface ErrorGroup {
  fingerprint: string;
  message: string;
  sources: ErrorSource[];
  occurrences: number;
  /** Distinct stores + panels affected. */
  entityCount: number;
  storeCount: number;
  panelCount: number;
  firstSeen: string;
  lastSeen: string;
}

/** A single occurrence of a fault, for the group detail view. */
export interface ErrorEvent {
  id: number;
  fingerprint: string;
  source: ErrorSource;
  entityType: 'store' | 'panel';
  entityId: number;
  message: string;
  appVersion: string | null;
  environment: string | null;
  occurrences: number;
  firstSeen: string;
  lastSeen: string;
}

export interface ErrorGroupDetail {
  ok: true;
  group: ErrorGroup;
  events: ErrorEvent[];
}

// --- Devices (§25) -----------------------------------------------------------

/**
 * `claimed`/`unclaimed` are POS-only: a till whose register has not reported a
 * device heartbeat yet is bound but not reporting, which is neither online nor
 * offline.
 */
export type DeviceStatus = 'online' | 'offline' | 'claimed' | 'unclaimed' | 'unknown';

export interface Device {
  id: string;
  name: string;
  type: 'pos' | 'office';
  /** Roster position (1 = Till 1); null for a Head Office. */
  till: number | null;
  storeId: number | null;
  /** The store's name, or a Head Office's own name. */
  storeName: string;
  storeSlug: string;
  companyName: string | null;
  environment: StoreEnvironment | null;
  vertical: StoreVertical | null;
  version: string | null;
  claimed: boolean;
  sessionOpen: boolean;
  deviceId: string | null;
  /** Per-device heartbeat — null until registers report one. */
  lastSeenAt: string | null;
  /** The store-level heartbeat, the fallback while the above is null. */
  lastHeartbeatAt: string | null;
  status: DeviceStatus;
  configState: ConfigState;
  healthStatus: HealthStatus;
}

// --- Versions (§32) ----------------------------------------------------------

export interface VersionMember {
  kind: 'store' | 'panel';
  id: number;
  name: string;
  /** Always null for a Head Office — the panels table has no environment. */
  environment: StoreEnvironment | null;
  schemaVersion: number | null;
  lastHeartbeatAt: string | null;
}

export interface VersionRow {
  /** null is a real bucket: registered but never reported a version. */
  version: string | null;
  stores: number;
  panels: number;
  byEnvironment: Record<StoreEnvironment, number>;
  lastHeartbeatAt: string | null;
  members: VersionMember[];
}

export interface VersionsView {
  versions: VersionRow[];
  schemas: Array<{ schemaVersion: number | null; stores: number }>;
  /** The build the most members run, per environment. */
  mostDeployed: Record<StoreEnvironment, string | null>;
  totals: {
    stores: number;
    panels: number;
    storesReporting: number;
    panelsReporting: number;
  };
}

// --- Deployments (§33) -------------------------------------------------------
// The client detail page still reads raw snake_case job rows; these are the
// camelCase shapes of the fleet-wide Releases > Deployments surface.

export type DeploymentJobStatus = 'pending' | 'running' | 'complete' | 'failed';
export type DeploymentStepStatus = 'pending' | 'running' | 'complete' | 'failed' | 'skipped';

export interface DeploymentStepCounts {
  total: number;
  failed: number;
  complete: number;
  skipped: number;
}

export interface DeploymentSummary {
  id: number;
  type: string;
  status: DeploymentJobStatus;
  error: string | null;
  companyId: number;
  companyName: string;
  startedAt: string;
  completedAt: string | null;
  /** Tallies only — the detail route's `steps` is the row list. */
  stepCounts: DeploymentStepCounts;
}

export interface DeploymentStepView {
  id: number;
  stepKey: string;
  resourceType: string;
  resourceId: number | null;
  status: DeploymentStepStatus;
  attempts: number;
  error: string | null;
  /** Best-effort operations that did not succeed while the step still completed. */
  warnings: string[];
  startedAt: string | null;
  completedAt: string | null;
}

export interface DeploymentDetail {
  ok: true;
  job: DeploymentSummary;
  steps: DeploymentStepView[];
}
