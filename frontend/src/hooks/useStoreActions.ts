import { useState } from 'react';
import { api, ApiError } from '../api';
import type {
  HealthOutcome,
  PushOutcome,
  ResetAdminResponse,
  Store,
} from '../types';

export interface AdminPasswordReveal {
  storeName: string;
  tempPassword: string;
  note: string;
}

/**
 * Store actions shared by the fleet page, the client detail page and the store
 * detail page — one implementation of push / diagnostics / support / pause /
 * remove so every surface behaves identically.
 */
export function useStoreActions(options: {
  notify: (kind: 'ok' | 'error', text: string) => void;
  reload: () => Promise<void>;
  onAdminPassword: (reveal: AdminPasswordReveal) => void;
}) {
  const [busyId, setBusyId] = useState<number | null>(null);
  const [supportBusy, setSupportBusy] = useState(false);
  const [supportError, setSupportError] = useState<string | null>(null);
  const { notify, reload, onAdminPassword } = options;

  const runAction = async (store: Store, action: () => Promise<void>): Promise<void> => {
    setBusyId(store.id);
    try {
      await action();
      await reload();
    } catch (err) {
      // Always show the underlying reason: a bare 'Action failed' tells the
      // operator nothing about what to do next.
      const message =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Action failed';
      notify('error', message);
    } finally {
      setBusyId(null);
    }
  };

  const pushNow = (store: Store): Promise<void> =>
    runAction(store, async () => {
      const res = await api<PushOutcome>(`/stores/${store.id}/push`, { method: 'POST' });
      notify(
        res.ok ? 'ok' : 'error',
        res.ok
          ? `Till 1..${store.terminalCount} pushed to ${store.slug}`
          : `Push failed: ${res.error}`,
      );
    });

  const healthCheck = (store: Store): Promise<void> =>
    runAction(store, async () => {
      const res = await api<HealthOutcome>(`/stores/${store.id}/health`, { method: 'POST' });
      notify(
        res.ok ? 'ok' : 'error',
        res.ok ? `${store.slug} is up` : `${store.slug} is down: ${res.error}`,
      );
    });

  const startSupport = async (store: Store, reason: string): Promise<boolean> => {
    setSupportBusy(true);
    setSupportError(null);
    try {
      await api<{ ok: boolean }>(`/stores/${store.id}/support`, {
        method: 'POST',
        body: { reason },
      });
      notify('ok', `Support session started for ${store.slug} — recorded in the audit trail.`);
      return true;
    } catch (err) {
      setSupportError(err instanceof ApiError ? err.message : 'Failed to start support session');
      return false;
    } finally {
      setSupportBusy(false);
    }
  };

  const supportIssuePassword = async (store: Store): Promise<boolean> => {
    setSupportBusy(true);
    setSupportError(null);
    try {
      const res = await api<ResetAdminResponse>(`/stores/${store.id}/reset-admin`, {
        method: 'POST',
      });
      onAdminPassword({ storeName: store.name, tempPassword: res.tempPassword, note: res.note });
      return true;
    } catch (err) {
      setSupportError(err instanceof ApiError ? err.message : 'Reset failed');
      return false;
    } finally {
      setSupportBusy(false);
    }
  };

  const removeStore = async (store: Store, onDone?: () => void): Promise<void> => {
    try {
      const res = await api<{ ok: boolean; message: string }>(`/stores/${store.id}`, {
        method: 'DELETE',
      });
      onDone?.();
      notify('ok', res.message);
      await reload();
    } catch (err) {
      onDone?.();
      notify('error', err instanceof ApiError ? err.message : 'Remove failed');
    }
  };

  const togglePause = (store: Store): Promise<void> =>
    runAction(store, async () => {
      await api<Store>(`/stores/${store.id}/${store.status === 'active' ? 'pause' : 'resume'}`, {
        method: 'PATCH',
      });
      notify('ok', store.status === 'active' ? `${store.name} paused` : `${store.name} resumed`);
    });

  return {
    busyId,
    supportBusy,
    supportError,
    setSupportError,
    runAction,
    pushNow,
    healthCheck,
    removeStore,
    togglePause,
    startSupport,
    supportIssuePassword,
  };
}
