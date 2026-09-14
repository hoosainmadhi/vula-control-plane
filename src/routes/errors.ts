import { Router } from 'express';
import {
  listErrorEvents,
  listErrorGroups,
  type ErrorEventRecord,
  type ErrorGroupRecord,
  type ErrorSource,
} from '../config/registryDb.js';
import { requireOffice } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { HttpError } from '../utils/errors.js';

export const errorsRouter = Router();
errorsRouter.use(requireOffice);

export interface ErrorEventOut {
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

const eventToOut = (e: ErrorEventRecord): ErrorEventOut => ({
  id: e.id,
  fingerprint: e.fingerprint,
  source: e.source,
  entityType: e.entity_type,
  entityId: e.entity_id,
  message: e.message,
  appVersion: e.app_version,
  environment: e.environment,
  occurrences: e.occurrences,
  firstSeen: e.first_seen,
  lastSeen: e.last_seen,
});

/**
 * The group behind a single fingerprint, derived from that group's own events
 * rather than re-queried, so the detail view can never disagree with the rows
 * it is showing. `events` arrives newest first, so the head is the message an
 * operator should read.
 */
const groupFromEvents = (fingerprint: string, events: ErrorEventRecord[]): ErrorGroupRecord => {
  const entities = new Set(events.map((e) => `${e.entity_type}:${e.entity_id}`));
  const stores = new Set(
    events.filter((e) => e.entity_type === 'store').map((e) => e.entity_id),
  );
  const panels = new Set(
    events.filter((e) => e.entity_type === 'panel').map((e) => e.entity_id),
  );
  return {
    fingerprint,
    message: events[0]!.message,
    sources: [...new Set(events.map((e) => e.source))],
    occurrences: events.reduce((total, e) => total + e.occurrences, 0),
    entityCount: entities.size,
    storeCount: stores.size,
    panelCount: panels.size,
    firstSeen: events.reduce((min, e) => (e.first_seen < min ? e.first_seen : min), events[0]!.first_seen),
    lastSeen: events.reduce((max, e) => (e.last_seen > max ? e.last_seen : max), events[0]!.last_seen),
  };
};

/**
 * The grouped failure feed across the fleet (§30) — newest first. Grouping and
 * counts come from the registry, so the page never has to fetch every event.
 */
errorsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json(listErrorGroups());
  }),
);

/** One group: its occurrences, every store and panel they came from. */
errorsRouter.get(
  '/:fingerprint',
  asyncHandler(async (req, res) => {
    const fingerprint = String(req.params.fingerprint);
    const events = listErrorEvents(fingerprint);
    if (events.length === 0) throw new HttpError(404, 'Error group not found');
    res.json({
      ok: true,
      group: groupFromEvents(fingerprint, events),
      events: events.map(eventToOut),
    });
  }),
);
