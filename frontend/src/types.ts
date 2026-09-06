// Wire types mirroring the control-plane API (src/routes/stores.ts).

export type StoreStatus = 'active' | 'paused';
export type ConfigStatus = 'pending' | 'ok' | 'failed';
export type HealthStatus = 'up' | 'down' | 'unknown';
export type StoreVertical = 'general' | 'clothing' | 'spares' | 'hardware' | 'pharmacy';

export interface Store {
  id: number;
  slug: string;
  name: string;
  vatRegNo: string | null;
  vertical: StoreVertical;
  terminalCount: number;
  baseUrl: string;
  status: StoreStatus;
  lastConfigStatus: ConfigStatus;
  lastConfigAt: string | null;
  lastHealthAt: string | null;
  lastHealthStatus: HealthStatus;
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
}

export interface ResetAdminResponse {
  ok: boolean;
  tempPassword: string;
  note: string;
}

export interface StoreFormValues {
  name: string;
  slug: string;
  vatRegNo: string;
  vertical: StoreVertical;
  baseUrl: string;
  terminalCount: string;
  controlPlaneToken: string;
}
