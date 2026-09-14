// Wire types mirroring the control-plane API (src/routes/stores.ts).

export type StoreStatus = 'active' | 'paused';
export type ConfigStatus = 'pending' | 'ok' | 'failed';
export type HealthStatus = 'up' | 'down' | 'unknown';
export type StoreVertical =
  | 'general'
  | 'clothing'
  | 'spares'
  | 'hardware'
  | 'pharmacy'
  | 'restaurant'
  | 'custom';

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
  status: 'pending' | 'paid' | 'overdue' | 'cancelled';
  dueDate: string | null;
  paidDate: string | null;
  createdAt: string;
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
