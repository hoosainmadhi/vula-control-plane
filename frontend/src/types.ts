// Wire types mirroring the control-plane API (src/routes/stores.ts).

export type StoreStatus = 'active' | 'paused';
export type ConfigStatus = 'pending' | 'ok' | 'failed';
export type HealthStatus = 'up' | 'down' | 'unknown';
export type StoreVertical = 'general' | 'clothing' | 'spares' | 'hardware' | 'pharmacy';

export type PlanPeriod = 'monthly' | 'annual' | 'once-off';

export interface Plan {
  id: number;
  code: string;
  name: string;
  maxStores: number;
  maxTerminalsPerStore: number;
  features: string[];
  priceCents: number;
  /** How the price recurs — 'once-off' is a perpetual licence, not a subscription. */
  billingPeriod: 'monthly' | 'annual' | 'once-off';
  isActive: boolean;
  createdAt: string;
}

export type BillingState = 'active' | 'trial' | 'past_due' | 'suspended' | 'unlicensed';

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

export interface Store {
  id: number;
  slug: string;
  name: string;
  vatRegNo?: string | null;
  vertical: StoreVertical;
  terminalCount: number;
  baseUrl: string;
  status: StoreStatus;
  lastConfigStatus: ConfigStatus;
  lastConfigAt: string | null;
  lastHealthAt: string | null;
  lastHealthStatus: HealthStatus;
  companyId: number | null;
  companyName: string;
  planCode: string;
  planName: string;
  billingState: string;
  entitlementNote: string;
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
  vatRegNo?: string;
  vertical: StoreVertical;
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
  totalTills: number;
  latestJobStatus: string | null;
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

export interface ClientDetailResponse {
  client: ClientListItem;
  headOffice: Panel | null;
  stores: Array<{
    id: number;
    name: string;
    slug: string;
    baseUrl: string;
    terminalCount: number;
    vertical: string;
    health: string;
    lastHealthAt: string | null;
    deployStatus?: string;
    coolifyUuid?: string | null;
    adminEmail?: string | null;
  }>;
  latestDeployment: {
    job: DeploymentJob;
    steps: DeploymentJobStep[];
  } | null;
}


