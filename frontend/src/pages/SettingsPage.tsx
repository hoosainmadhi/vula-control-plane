import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import ErrorBox from '../components/ErrorBox';
import Spinner from '../components/Spinner';
import type { OfficeSettings } from '../types';

/**
 * The control plane's own settings: who Vula is on an invoice, the payment terms
 * new invoices carry, and the SMTP account client emails are sent from.
 *
 * The SMTP password is never sent to the browser — the field shows a mask, and
 * submitting the mask leaves the stored credential alone. That is why the field
 * says so instead of pretending to be an empty input.
 */
const MASK = '••••••••';

const inputCls =
  'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none';
const labelCls = 'mb-1 block text-xs font-bold text-slate-700';

interface Form {
  officeName: string;
  officeEmail: string;
  officePhone: string;
  officeAddress: string;
  invoiceDueDays: string;
  invoiceFooter: string;
  vatRegNo: string;
  vatRate: string;
  smtpHost: string;
  smtpPort: string;
  smtpUser: string;
  smtpPass: string;
  smtpFrom: string;
}

const toForm = (s: OfficeSettings): Form => ({
  officeName: s.officeName,
  officeEmail: s.officeEmail,
  officePhone: s.officePhone,
  officeAddress: s.officeAddress,
  invoiceDueDays: String(s.invoiceDueDays),
  invoiceFooter: s.invoiceFooter,
  vatRegNo: s.vatRegNo,
  vatRate: String(s.vatRate),
  smtpHost: s.smtpHost,
  smtpPort: String(s.smtpPort),
  smtpUser: s.smtpUser,
  smtpPass: s.smtpPass,
  smtpFrom: s.smtpFrom,
});

export default function SettingsPage() {
  const [settings, setSettings] = useState<OfficeSettings | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [notice, setNotice] = useState('');
  const [testTo, setTestTo] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const load = useCallback(async () => {
    setLoadError('');
    try {
      const res = await api<{ settings: OfficeSettings }>('/settings');
      setSettings(res.settings);
      setForm(toForm(res.settings));
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Could not load settings');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!form) return;
    setSaving(true);
    setSaveError('');
    setNotice('');
    try {
      const res = await api<{ settings: OfficeSettings }>('/settings', {
        method: 'PUT',
        body: {
          officeName: form.officeName,
          officeEmail: form.officeEmail,
          officePhone: form.officePhone,
          officeAddress: form.officeAddress,
          invoiceDueDays: Number(form.invoiceDueDays),
          invoiceFooter: form.invoiceFooter,
          vatRegNo: form.vatRegNo,
          vatRate: Number(form.vatRate),
          smtpHost: form.smtpHost,
          smtpPort: Number(form.smtpPort),
          smtpUser: form.smtpUser,
          // The mask means "leave the password alone"; only a real value replaces it.
          smtpPass: form.smtpPass,
          smtpFrom: form.smtpFrom,
        },
      });
      setSettings(res.settings);
      setForm(toForm(res.settings));
      setNotice('Settings saved.');
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : 'Could not save settings');
    } finally {
      setSaving(false);
    }
  };

  const sendTest = async (): Promise<void> => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await api<{ to: string }>('/settings/test-email', {
        method: 'POST',
        body: testTo.trim() ? { to: testTo.trim() } : {},
      });
      setTestResult({ ok: true, message: `Test email accepted by the mail server for ${res.to}.` });
    } catch (err) {
      setTestResult({
        ok: false,
        message: err instanceof ApiError ? err.message : 'The test email could not be sent',
      });
    } finally {
      setTesting(false);
    }
  };

  if (loading) return <Spinner label="Loading settings…" />;
  if (loadError) {
    return (
      <div className="space-y-4">
        <ErrorBox message={loadError} />
        <button
          onClick={() => void load()}
          className="text-sm font-semibold text-brand-600 hover:underline"
        >
          Retry
        </button>
      </div>
    );
  }
  if (!form || !settings) return null;

  const set = (patch: Partial<Form>): void => setForm({ ...form, ...patch });

  return (
    <div className="space-y-5">
      <form onSubmit={(e) => void save(e)} className="space-y-5">
        {saveError && <ErrorBox message={saveError} />}
        {notice && (
          <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm font-semibold text-green-800">
            {notice}
          </div>
        )}

        {/* Office identity — what a client sees on an invoice email */}
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs">
          <h3 className="text-sm font-bold text-slate-900">Office identity</h3>
          <p className="mt-1 text-xs text-slate-500">
            Shown on every invoice the control plane emails to a client. This is the vendor's own
            identity — merchant details never belong here.
          </p>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <label className={labelCls}>Office name</label>
              <input
                required
                value={form.officeName}
                onChange={(e) => set({ officeName: e.target.value })}
                className={inputCls}
                placeholder="Vula"
              />
            </div>
            <div>
              <label className={labelCls}>Billing email</label>
              <input
                type="email"
                value={form.officeEmail}
                onChange={(e) => set({ officeEmail: e.target.value })}
                className={inputCls}
                placeholder="accounts@vula.app"
              />
              <p className="mt-1 text-[11px] text-slate-400">
                Also the default recipient for the SMTP test below.
              </p>
            </div>
            <div>
              <label className={labelCls}>Phone</label>
              <input
                value={form.officePhone}
                onChange={(e) => set({ officePhone: e.target.value })}
                className={inputCls}
                placeholder="+27 11 555 0100"
              />
            </div>
            <div>
              <label className={labelCls}>Address</label>
              <input
                value={form.officeAddress}
                onChange={(e) => set({ officeAddress: e.target.value })}
                className={inputCls}
                placeholder="1 Main Road, Johannesburg"
              />
            </div>
          </div>
        </section>

        {/* Invoicing */}
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs">
          <h3 className="text-sm font-bold text-slate-900">Invoicing</h3>
          <p className="mt-1 text-xs text-slate-500">
            Terms and tax applied when the control plane raises the next invoice.
          </p>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <label className={labelCls}>VAT registration number</label>
              <input
                value={form.vatRegNo}
                onChange={(e) => set({ vatRegNo: e.target.value })}
                className={inputCls}
                placeholder="4123456789"
              />
              <p className="mt-1 text-[11px] text-slate-400">
                Vula&apos;s own registration. With it set, an invoice is headed{' '}
                <strong>Tax invoice</strong> and carries the number; blank leaves it an invoice.
              </p>
            </div>
            <div>
              <label className={labelCls}>VAT rate (%)</label>
              <input
                required
                type="number"
                min={0}
                max={100}
                value={form.vatRate}
                onChange={(e) => set({ vatRate: e.target.value })}
                className={inputCls}
              />
              <p className="mt-1 text-[11px] text-slate-400">
                Plan prices are quoted <strong>including VAT</strong>, so the invoice shows the
                split behind the total. Raised invoices keep the rate they were issued at.
              </p>
            </div>
            <div>
              <label className={labelCls}>Payment terms (days)</label>
              <input
                required
                type="number"
                min={1}
                max={180}
                value={form.invoiceDueDays}
                onChange={(e) => set({ invoiceDueDays: e.target.value })}
                className={inputCls}
              />
              <p className="mt-1 text-[11px] text-slate-400">
                The due date on a new invoice — 30 for "payable within 30 days".
              </p>
            </div>
            <div>
              <label className={labelCls}>Invoice footer</label>
              <textarea
                rows={3}
                value={form.invoiceFooter}
                onChange={(e) => set({ invoiceFooter: e.target.value })}
                className={inputCls}
                placeholder={'Bank: FNB\nAccount: 12345\nReference: your invoice number'}
              />
            </div>
          </div>
        </section>

        {/* SMTP */}
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-2xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-bold text-slate-900">Outgoing mail (SMTP)</h3>
            <span
              className={`rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide ${
                settings.smtpConfigured
                  ? 'bg-green-50 text-green-700'
                  : 'bg-amber-50 text-amber-700'
              }`}
            >
              {settings.smtpConfigured ? 'Configured' : 'Not configured'}
            </span>
          </div>
          <p className="mt-1 text-xs text-slate-500">
            Where invoices to clients are sent from. Without a host, "Email to client" refuses
            rather than reporting a send that never happened.
          </p>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <label className={labelCls}>Host</label>
              <input
                value={form.smtpHost}
                onChange={(e) => set({ smtpHost: e.target.value })}
                className={inputCls}
                placeholder="smtp.example.co.za"
              />
            </div>
            <div>
              <label className={labelCls}>Port</label>
              <input
                required
                type="number"
                min={1}
                max={65535}
                value={form.smtpPort}
                onChange={(e) => set({ smtpPort: e.target.value })}
                className={inputCls}
              />
              <p className="mt-1 text-[11px] text-slate-400">
                465 uses TLS from the start; 587 negotiates STARTTLS.
              </p>
            </div>
            <div>
              <label className={labelCls}>Username</label>
              <input
                value={form.smtpUser}
                onChange={(e) => set({ smtpUser: e.target.value })}
                className={inputCls}
                placeholder="billing@vula.app"
              />
            </div>
            <div>
              <label className={labelCls}>Password</label>
              <input
                value={form.smtpPass}
                onChange={(e) => set({ smtpPass: e.target.value })}
                className={inputCls}
                placeholder="•"
              />
              <p className="mt-1 text-[11px] text-slate-400">
                {form.smtpPass === MASK
                  ? 'A password is stored. Clear the field to remove it.'
                  : 'Leave blank to keep the stored password.'}
              </p>
            </div>
            <div>
              <label className={labelCls}>From address</label>
              <input
                type="email"
                value={form.smtpFrom}
                onChange={(e) => set({ smtpFrom: e.target.value })}
                className={inputCls}
                placeholder="billing@vula.app"
              />
            </div>
          </div>

          <div className="mt-5 flex flex-wrap items-end gap-3 border-t border-slate-100 pt-4">
            <div className="min-w-[240px] flex-1">
              <label className={labelCls}>Send a test email to</label>
              <input
                type="email"
                value={testTo}
                onChange={(e) => setTestTo(e.target.value)}
                className={inputCls}
                placeholder={settings.officeEmail || 'accounts@vula.app'}
              />
            </div>
            <button
              type="button"
              onClick={() => void sendTest()}
              disabled={testing}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              {testing ? 'Sending…' : 'Send test email'}
            </button>
          </div>
          {testResult && (
            <p
              className={`mt-3 text-xs font-semibold ${
                testResult.ok ? 'text-green-700' : 'text-red-600'
              }`}
            >
              {testResult.message}
            </p>
          )}
          <p className="mt-3 text-[11px] text-slate-400">
            Save the SMTP block first — the test uses the stored settings, not what is typed here.
          </p>
        </section>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={saving}
            className="rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save settings'}
          </button>
          <button
            type="button"
            onClick={() => setForm(toForm(settings))}
            className="text-sm font-semibold text-slate-500 hover:text-slate-700"
          >
            Reset changes
          </button>
        </div>
      </form>

      <p className="text-[11px] text-slate-400">
        Last updated {settings.updatedAt} (UTC). The SMTP password is stored so the control plane
        can send mail; it is never returned to the browser.
      </p>
    </div>
  );
}
