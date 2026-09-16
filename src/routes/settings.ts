/**
 * The control plane's own settings — office identity, invoice payment terms and
 * the SMTP account it sends from. Office-gated like every other management
 * surface; the singleton row is created on first boot (registryDb).
 */
import { Router } from 'express';
import { recordAuditLog } from '../config/registryDb.js';
import { requireOffice } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ValidationError, optionalString, requireInt } from '../utils/validate.js';
import {
  applyOfficeSettingsPatch,
  defaultMailRecipient,
  getOfficeSettingsOut,
  getRawOfficeSettings,
  type OfficeSettingsPatch,
} from '../services/officeSettings.js';
import { isSmtpConfigured, sendTestEmail, SmtpNotConfiguredError } from '../services/mailer.js';

export const settingsRouter = Router();
settingsRouter.use(requireOffice);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Reads one optional free-text field. Absent leaves it alone; an empty string
 * clears it — which is how SMTP is switched off and how a footer is removed.
 */
const textField = (
  body: Record<string, unknown>,
  key: string,
  maxLength = 500,
): string | undefined => {
  if (body[key] === undefined) return undefined;
  const value = optionalString(body, key, maxLength);
  return value ?? '';
};

settingsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json({ settings: getOfficeSettingsOut() });
  }),
);

settingsRouter.put(
  '/',
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const before = getOfficeSettingsOut();
    const patch: OfficeSettingsPatch = {};

    const name = textField(body, 'officeName', 120);
    if (name !== undefined) {
      if (!name) throw new ValidationError('officeName cannot be empty — invoices need a sender');
      patch.office_name = name;
    }

    for (const [key, column, max] of [
      ['officeEmail', 'office_email', 254],
      ['officePhone', 'office_phone', 40],
      ['officeAddress', 'office_address', 400],
      ['invoiceFooter', 'invoice_footer', 1000],
      ['smtpHost', 'smtp_host', 254],
      ['smtpUser', 'smtp_user', 254],
      ['smtpFrom', 'smtp_from', 254],
      ['smtpPass', 'smtp_pass', 200],
    ] as const) {
      const value = textField(body, key, max);
      if (value !== undefined) patch[column] = value;
    }

    if (patch.office_email && !EMAIL_RE.test(patch.office_email)) {
      throw new ValidationError('officeEmail is not a valid email address');
    }
    if (patch.smtp_from && !EMAIL_RE.test(patch.smtp_from)) {
      throw new ValidationError('smtpFrom is not a valid email address');
    }
    if (body['invoiceDueDays'] !== undefined) {
      patch.invoice_due_days = requireInt(body, 'invoiceDueDays', { min: 1, max: 180 });
    }
    if (body['smtpPort'] !== undefined) {
      patch.smtp_port = requireInt(body, 'smtpPort', { min: 1, max: 65535 });
    }
    // Clearing the host switches SMTP off entirely; keeping a password for a
    // server that is no longer configured would leave a credential behind.
    if (patch.smtp_host === '') {
      patch.smtp_user = '';
      patch.smtp_pass = '';
      patch.smtp_from = '';
    }

    const settings = applyOfficeSettingsPatch(patch);
    recordAuditLog('office', 'settings_updated', 'office_settings', null, {
      before,
      // The masked view: the audit trail must not become a second store of the
      // SMTP password.
      after: settings,
      reason: 'Control plane settings updated',
    });
    res.json({ settings });
  }),
);

settingsRouter.post(
  '/test-email',
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const settings = getRawOfficeSettings();
    // The missing mail server is the more useful thing to say when there is no
    // mail server: asking for a recipient first would send the operator to fix
    // the wrong field.
    if (!isSmtpConfigured(settings)) throw new SmtpNotConfiguredError();
    const to = optionalString(body, 'to', 254) || defaultMailRecipient(settings);
    if (!to) {
      throw new ValidationError(
        'Set an office email address (or name a recipient) so the test has somewhere to go',
      );
    }
    if (!EMAIL_RE.test(to)) throw new ValidationError('to is not a valid email address');

    const result = await sendTestEmail(to);
    recordAuditLog('office', 'settings_test_email', 'office_settings', null, {
      after: { to },
      reason: `Sent an SMTP test email to ${to}`,
    });
    res.json({ ok: true, to: result.to, messageId: result.messageId });
  }),
);
