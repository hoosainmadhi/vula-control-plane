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
  nextPanelLicenceSequence,
  recordPanelHealth,
  recordPanelLicencePush,
  updatePanel,
  type PanelRecord,
} from '../config/registryDb.js';
import { requireOffice } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { HttpError } from '../utils/errors.js';
import { ValidationError, optionalString, parseIdParam, requireSlug, requireString } from '../utils/validate.js';
import {
  pingPanel,
  probeAppKind,
  pushLicenceToPanel,
  StoreClientError,
} from '../services/storeClient.js';
import { issueLicence, isEphemeralKey, licenceKeyId, licencePublicKey } from '../services/licenceSigner.js';
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
): Promise<{ ok: boolean; error?: string; sequence?: number }> => {
  try {
    const company = getCompanyById(panel.company_id);
    const ent = entitlementsFor(company);
    const sequence = nextPanelLicenceSequence(panel.id);
    const signed = issueLicence({
      sequence,
      storeSlug: panel.slug,
      storeName: panel.name,
      companyId: ent.companyId,
      companyName: ent.companyName,
      planCode: ent.planCode,
      planName: ent.planName,
      features: ent.features,
      maxStores: ent.maxStores,
      maxTerminalsPerStore: ent.maxTerminalsPerStore,
      paidThrough: ent.paidThrough,
      billingState: ent.billingState,
    });
    await pushLicenceToPanel(
      { base_url: panel.base_url, control_plane_token: panel.control_plane_token },
      signed.token,
    );
    recordPanelLicencePush(panel.id, 'ok');
    return { ok: true, sequence };
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

panelsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const name = requireString(req.body, 'name');
    const slug = requireSlug(req.body);
    const companyId = Number(req.body?.companyId);
    const baseUrl = requireString(req.body, 'baseUrl', 300);
    if (!/^https?:\/\//.test(baseUrl)) {
      throw new ValidationError('baseUrl must start with http:// or https://');
    }
    const company = Number.isInteger(companyId) ? getCompanyById(companyId) : null;
    if (!company) throw new ValidationError('companyId does not match a known company');
    if (getPanelBySlug(slug)) {
      res.status(409).json({ error: `A panel with slug "${slug}" already exists` });
      return;
    }
    // A Head Office row must point at a Head Office. A store deployment answers as
    // `app: vula`, which can never authenticate as a panel — so say so plainly
    // rather than letting it sit there showing "Down".
    //
    // Only a *definitive* mismatch is refused. An unreachable URL is allowed,
    // because the registry row is normally created before the container is
    // deployed, and 'unknown' is allowed for the same reason.
    const probe = await probeAppKind(baseUrl);
    if (probe.reachable && probe.kind === 'store') {
      res.status(409).json({
        error: `${baseUrl} is a store deployment, not a Head Office. A Head Office is a separate application on its own URL — see the Head Offices page for what that means.`,
        code: 'wrong_app_kind',
      });
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
      throw new ValidationError('controlPlaneToken must be 64 lowercase hex characters when supplied');
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
    const updated = updatePanel(panel.id, {
      ...(body.name !== undefined ? { name: String(body.name).trim() } : {}),
      ...(body.baseUrl !== undefined
        ? { baseUrl: String(body.baseUrl).trim().replace(/\/+$/, '') }
        : {}),
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
    res.json({ ok: true, sequence: outcome.sequence, panel: panelToOut(updated) });
  }),
);
