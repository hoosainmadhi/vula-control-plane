import crypto from 'node:crypto';
import { Router } from 'express';
import {
  createPanel,
  deletePanel,
  getCompanyById,
  getPanelById,
  getPanelBySlug,
  listPanels,
  recordAuditLog,
  recordPanelHealth,
  recordPanelLicencePush,
  updatePanel,
  type PanelRecord,
} from '../config/registryDb.js';
import { requireOffice } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { HttpError } from '../utils/errors.js';
import {
  ValidationError,
  optionalString,
  parseIdParam,
  requireBaseUrl,
  requireSlug,
  requireString,
} from '../utils/validate.js';
import { assertManagedEndpoint, pingPanel, StoreClientError } from '../services/storeClient.js';
import { bootstrapHeadOfficeAdmin } from '../services/storeClient.js';
import { generateAdminPassword } from '../services/storeProvisioning.js';
import { trySendAdminCredentialsEmail, type AdminCredentialsDelivery } from '../services/mailer.js';
import {
  deliverPanelLicence,
  type LicenceSequenceReconciliation,
} from '../services/licenceDelivery.js';
import { isEphemeralKey, licenceKeyId, licencePublicKey } from '../services/licenceSigner.js';
import { entitlementsFor } from '../services/subscriptions.js';

export const panelsRouter = Router();
panelsRouter.use(requireOffice);

/**
 * The Company Control Panel is a *separate application* from a store: one per
 * merchant, deployed and monitored by the control plane, reached directly by the
 * client at its own URL.
 *
 * Privacy boundary (deliberate, and enforced by tests): these endpoints expose
 * operational metadata only — URL, health, version, config and licence state.
 * They never proxy or aggregate anything inside the panel. Business data belongs
 * to the merchant's own app and never passes through here.
 */
export interface PanelOut {
  id: number;
  companyId: number;
  companyName: string;
  slug: string;
  name: string;
  baseUrl: string;
  adminEmail: string | null;
  status: 'active' | 'paused';
  lastHealthStatus: 'up' | 'down' | 'unknown';
  lastHealthAt: string | null;
  appVersion: string | null;
  licenceSequence: number;
  licenceIssuedAt: string | null;
  licencePushStatus: 'pending' | 'ok' | 'failed';
  licencePushedAt: string | null;
  /** Plan entitlement behind the panel, for the licence column. */
  planCode: string;
  planName: string;
  billingState: string;
  createdAt: string;
}

const panelToOut = (panel: PanelRecord): PanelOut => {
  const company = getCompanyById(panel.company_id);
  const ent = entitlementsFor(company);
  return {
    id: panel.id,
    companyId: panel.company_id,
    companyName: company?.name ?? '',
    slug: panel.slug,
    name: panel.name,
    baseUrl: panel.base_url,
    adminEmail: panel.admin_email ?? null,
    status: panel.status,
    lastHealthStatus: panel.last_health_status,
    lastHealthAt: panel.last_health_at,
    appVersion: panel.app_version,
    licenceSequence: panel.licence_sequence,
    licenceIssuedAt: panel.licence_issued_at,
    licencePushStatus: panel.licence_push_status,
    licencePushedAt: panel.licence_pushed_at,
    planCode: ent.planCode,
    planName: ent.planName,
    billingState: ent.billingState,
    createdAt: panel.created_at,
  };
};

const panelFromParams = (raw: string): PanelRecord => {
  const panel = getPanelById(parseIdParam(raw));
  if (!panel) throw new HttpError(404, 'Panel not found');
  return panel;
};

/** Sign and deliver the company licence to a panel. Failure records, never throws. */
const attemptPanelLicencePush = async (
  panel: PanelRecord,
): Promise<{
  ok: boolean;
  error?: string;
  sequence?: number;
  reconciled?: LicenceSequenceReconciliation;
}> => {
  try {
    const { sequence, reconciled } = await deliverPanelLicence(panel);
    recordPanelLicencePush(panel.id, 'ok');
    return { ok: true, sequence, ...(reconciled ? { reconciled } : {}) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordPanelLicencePush(panel.id, 'failed', message);
    return { ok: false, error: message };
  }
};

panelsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json(listPanels().map(panelToOut));
  }),
);

// Issue the Head Office executive's one-time login. This is also the recovery
// path: the deploy step's bootstrap attempt fails while the container builds
// and is never revisited, so a young Head Office often has no executive yet.
// The tenant HO has no password-reset endpoint — an existing executive's
// password is out of scope here.
panelsRouter.post(
  '/:id/reset-admin',
  asyncHandler(async (req, res) => {
    const panel = panelFromParams(req.params.id);
    if (panel.status === 'paused') {
      res.status(409).json({ error: 'Panel is paused — resume before issuing a login' });
      return;
    }
    const recipient = panel.admin_email ?? getCompanyById(panel.company_id)?.billing_email ?? null;
    if (!recipient) {
      throw new HttpError(
        400,
        'No admin address on record for this Head Office — set the client’s billing email first.',
        'panel_admin_address_missing',
      );
    }
    const tempPassword = generateAdminPassword();
    // Throws as a 502 StoreClientError when the tenant refuses — a 409 means an
    // executive already exists, and the HO has no password-reset endpoint, so
    // that refusal is the honest limit of this action.
    await bootstrapHeadOfficeAdmin(panel, {
      name: 'Head Office Administrator',
      email: recipient,
      password: tempPassword,
    });
    const delivery: AdminCredentialsDelivery = await trySendAdminCredentialsEmail({
      surface: panel.name,
      loginUrl: panel.base_url,
      adminEmail: recipient,
      tempPassword,
    });
    recordAuditLog('office', 'reset_panel_admin', 'panel', panel.id, {
      reason: 'Head Office executive login issued from the panel row',
      ...(delivery.emailed ? { emailedTo: delivery.emailedTo } : {}),
      ...(delivery.emailError ? { emailError: delivery.emailError } : {}),
    });
    res.json({
      ok: true,
      tempPassword,
      note: 'Shown once — the control plane does not store it.',
      ...(delivery.emailed
        ? { emailedTo: delivery.emailedTo }
        : delivery.emailError
          ? { emailError: `Credentials email not sent: ${delivery.emailError}` }
          : {}),
    });
  }),
);

panelsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const name = requireString(req.body, 'name');
    const slug = requireSlug(req.body);
    const companyId = Number(req.body?.companyId);
    const baseUrl = requireBaseUrl(req.body);
    const company = Number.isInteger(companyId) ? getCompanyById(companyId) : null;
    if (!company) throw new ValidationError('companyId does not match a known company');
    if (getPanelBySlug(slug)) {
      res.status(409).json({ error: `A panel with slug "${slug}" already exists` });
      return;
    }
    // A Head Office row must point at a Head Office, and in production at a live
    // public one — the same policy stores get, through the same helper. Only a
    // definitive mismatch is refused: an unreachable URL and 'unknown' are
    // allowed in development, because the row is normally created before the
    // container is deployed.
    const check = await assertManagedEndpoint(baseUrl, 'head-office');
    if (!check.ok) {
      res.status(check.status).json({ error: check.error, code: check.code });
      return;
    }
    const normalised = baseUrl.replace(/\/+$/, '');
    const clash = listPanels().find((p) => p.base_url.replace(/\/+$/, '') === normalised);
    if (clash) {
      res.status(409).json({
        error: `That URL is already registered as "${clash.slug}" (${clash.name}). One Head Office deployment has one registry row.`,
        code: 'base_url_in_use',
      });
      return;
    }

    // As with stores, the operator may paste the token the panel env already
    // holds; otherwise one is generated. The token never leaves the server.
    const supplied = optionalString(req.body, 'controlPlaneToken', 64);
    let controlPlaneToken: string;
    if (supplied === undefined || supplied === null) {
      controlPlaneToken = crypto.randomBytes(32).toString('hex');
    } else if (supplied.length === 64 && /^[0-9a-f]+$/.test(supplied)) {
      controlPlaneToken = supplied;
    } else {
      throw new ValidationError(
        'controlPlaneToken must be 64 lowercase hex characters when supplied',
      );
    }

    const panel = createPanel({
      companyId: company.id,
      slug,
      name,
      baseUrl: baseUrl.replace(/\/+$/, ''),
      controlPlaneToken,
    });
    const firstLicence = await attemptPanelLicencePush(getPanelById(panel.id)!);
    res.status(201).json({ panel: panelToOut(getPanelById(panel.id)!), firstLicence });
  }),
);

panelsRouter.get(
  '/licence/key',
  asyncHandler(async (_req, res) => {
    res.json({
      keyId: licenceKeyId(),
      algorithm: 'ES256',
      publicKey: licencePublicKey(),
      ephemeral: isEphemeralKey(),
    });
  }),
);

panelsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json(panelToOut(panelFromParams(req.params.id)));
  }),
);

panelsRouter.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const panel = panelFromParams(req.params.id);
    const body = req.body ?? {};
    if (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim())) {
      throw new ValidationError('name must be a non-empty string');
    }
    if (
      body.status !== undefined &&
      !['active', 'paused'].includes(String(body.status))
    ) {
      throw new ValidationError('status must be active or paused');
    }
    // The panel edit route previously accepted a new base URL with no validation
    // at all — not even the scheme check the create route had. Repointing a Head
    // Office moves every panel licence push to the new host, so it carries the
    // same policy as creation.
    let nextBaseUrl: string | undefined;
    if (body.baseUrl !== undefined) {
      nextBaseUrl = requireBaseUrl({ baseUrl: body.baseUrl });
      if (nextBaseUrl !== panel.base_url) {
        const check = await assertManagedEndpoint(nextBaseUrl, 'head-office');
        if (!check.ok) {
          res.status(check.status).json({ error: check.error, code: check.code });
          return;
        }
      }
    }
    const updated = updatePanel(panel.id, {
      ...(body.name !== undefined ? { name: String(body.name).trim() } : {}),
      ...(nextBaseUrl !== undefined ? { baseUrl: nextBaseUrl } : {}),
      ...(body.status !== undefined ? { status: body.status as 'active' | 'paused' } : {}),
    });
    res.json(panelToOut(updated!));
  }),
);

/** Ping the panel's own token-guarded status endpoint; records health + version. */
/** Remove a Head Office registration (e.g. the merchant left the multi-store plan). */
panelsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const panel = panelFromParams(req.params.id);
    // Pause-first teardown, matching stores: a Head Office deployment keeps
    // running whether or not the registry row exists, so removing an active
    // panel would stop the control plane managing a live system by surprise
    // (production review, 2026-09-23).
    if (panel.status === 'active') {
      res.status(409).json({
        error: `${panel.name} is active. Pause it first, then remove it — the Head Office deployment keeps running, so the control plane should stop managing it deliberately rather than by surprise.`,
        code: 'panel_active',
      });
      return;
    }
    deletePanel(panel.id);
    res.json({ ok: true, message: `${panel.name} removed` });
  }),
);

/** Reveal the panel's vendor token — the only way it is ever shown after
 * creation. Needed exactly once, to configure CONTROL_PLANE_TOKEN on the
 * panel deployment; audited like every secret operation. */
panelsRouter.get(
  '/:id/token',
  asyncHandler(async (req, res) => {
    const panel = panelFromParams(req.params.id);
    recordAuditLog('office', 'reveal_panel_token', 'panel', panel.id, {
      reason: 'Panel token revealed to configure the deployment env',
    });
    res.json({
      ok: true,
      token: panel.control_plane_token,
      note: 'Set as CONTROL_PLANE_TOKEN on the panel deployment — anyone holding it can reach the panel vendor surface.',
    });
  }),
);

panelsRouter.post(
  '/:id/health',
  asyncHandler(async (req, res) => {
    const panel = panelFromParams(req.params.id);
    try {
      const detail = (await pingPanel({
        base_url: panel.base_url,
        control_plane_token: panel.control_plane_token,
      })) as { version?: string } | null;
      const updated = recordPanelHealth(panel.id, 'up', detail?.version ?? null);
      // A reachable panel is a good moment to refresh its licence.
      await attemptPanelLicencePush(getPanelById(panel.id)!);
      res.json({ ok: true, healthStatus: 'up', checkedAt: updated?.last_health_at ?? null });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const updated = recordPanelHealth(panel.id, 'down', null, reason);
      if (!(err instanceof StoreClientError)) {
        // Unexpected failures are logged; the operator just sees 'down'.
      }
      res.json({
        ok: false,
        healthStatus: 'down',
        checkedAt: updated?.last_health_at ?? null,
        error: reason,
      });
    }
  }),
);

panelsRouter.post(
  '/:id/licence',
  asyncHandler(async (req, res) => {
    const panel = panelFromParams(req.params.id);
    const outcome = await attemptPanelLicencePush(panel);
    const updated = getPanelById(panel.id)!;
    if (!outcome.ok) {
      res.status(502).json({ ok: false, panel: panelToOut(updated), error: outcome.error });
      return;
    }
    res.json({
      ok: true,
      sequence: outcome.sequence,
      ...(outcome.reconciled ? { reconciled: outcome.reconciled } : {}),
      panel: panelToOut(updated),
    });
  }),
);
