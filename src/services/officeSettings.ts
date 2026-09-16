/**
 * The control plane's own settings: who the vendor is, the payment terms its
 * invoices carry, and the SMTP account it sends from.
 *
 * Two rules shape this module:
 *
 * 1. **The SMTP password never leaves the server.** `toOfficeSettingsOut()`
 *    masks it and `PUT /api/settings` treats the mask as "leave it alone", so a
 *    form round-trip cannot blank a working credential.
 * 2. **Nothing here is a merchant's data.** Office identity and mailer
 *    credentials only — no client, store or trading value is stored in the
 *    singleton (§40 privacy boundary).
 */
import {
  getOfficeSettings,
  updateOfficeSettings,
  type OfficeSettingsRecord,
} from '../config/registryDb.js';

/** What the API returns. `smtpPass` is a mask, never the stored value. */
export interface OfficeSettingsOut {
  officeName: string;
  officeEmail: string;
  officePhone: string;
  officeAddress: string;
  invoiceDueDays: number;
  invoiceFooter: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  smtpFrom: string;
  /** True when a host is set — the mailer refuses to send without one. */
  smtpConfigured: boolean;
  updatedAt: string;
}

/** The value the API shows in place of a stored secret. */
export const SECRET_MASK = '••••••••';

export const toOfficeSettingsOut = (
  row: OfficeSettingsRecord,
  maskSecrets = true,
): OfficeSettingsOut => ({
  officeName: row.office_name,
  officeEmail: row.office_email,
  officePhone: row.office_phone,
  officeAddress: row.office_address,
  invoiceDueDays: row.invoice_due_days,
  invoiceFooter: row.invoice_footer,
  smtpHost: row.smtp_host,
  smtpPort: row.smtp_port,
  smtpUser: row.smtp_user,
  smtpPass: maskSecrets && row.smtp_pass ? SECRET_MASK : row.smtp_pass,
  smtpFrom: row.smtp_from,
  smtpConfigured: Boolean(row.smtp_host),
  updatedAt: row.updated_at,
});

export const getOfficeSettingsOut = (): OfficeSettingsOut =>
  toOfficeSettingsOut(getOfficeSettings());

/** The unmasked row — for the mailer and for internal callers only. */
export const getRawOfficeSettings = (): OfficeSettingsRecord => getOfficeSettings();

export type OfficeSettingsPatch = Partial<Omit<OfficeSettingsRecord, 'id' | 'updated_at'>>;

/**
 * Applies a patch. A secret sent back as the mask (or omitted) keeps the stored
 * value; an empty string clears it, which is how SMTP is switched off.
 */
export const applyOfficeSettingsPatch = (patch: OfficeSettingsPatch): OfficeSettingsOut => {
  const next = { ...patch };
  if (next.smtp_pass === SECRET_MASK) delete next.smtp_pass;
  return toOfficeSettingsOut(updateOfficeSettings(next));
};

/** The address a test send should go to when the caller names none. */
export const defaultMailRecipient = (row: OfficeSettingsRecord): string =>
  row.office_email || row.smtp_from;
