import { logger } from '../utils/logger.js';
import { runHealthSweep, type HealthSweepSummary } from './healthSweep.js';

export interface SweepSchedule {
  /** Cancels the schedule. Safe to call more than once. */
  stop(): void;
  /** Runs a sweep now, through the same in-flight guard. */
  runNow(): Promise<void>;
}

/**
 * Runs the health sweep on a timer.
 *
 * The sweep existed only as a route, so health, version, latency and sync state
 * were as fresh as the last time somebody pressed the button — which is why the
 * fleet page could report a store `up` from the day it was deployed, weeks after
 * it stopped answering. A control plane whose whole purpose is "is the fleet
 * okay" has to answer that on its own rather than from an old probe.
 *
 * Two behaviours worth knowing:
 *
 *  - **A tick is skipped, never queued, while a sweep is still running.** An
 *    unreachable store costs a timeout, and a fleet of them can make one sweep
 *    slow; stacking sweeps behind each other would turn a slow fleet into a
 *    growing queue of network calls.
 *  - **The first sweep is one interval after boot, not at boot.** Nothing is lost
 *    by waiting (the recorded state is in SQLite and survives a restart), and a
 *    restart loop should not trigger a fleet-wide probe each time.
 *
 * An interval of 0, or a value that is not a positive number, disables the
 * schedule and says so once.
 */
export const startHealthSweep = (
  intervalMinutes: number,
  sweep: () => Promise<HealthSweepSummary> = runHealthSweep,
): SweepSchedule | null => {
  if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
    logger.info(
      'Automatic health sweep is off (HEALTH_SWEEP_INTERVAL_MINUTES is 0 or unusable) — health and version state will only be as fresh as the last manual check',
    );
    return null;
  }

  let inFlight = false;

  const runNow = async (): Promise<void> => {
    if (inFlight) {
      logger.warn('A health sweep is still running — skipping this tick rather than queuing');
      return;
    }
    inFlight = true;
    try {
      await sweep();
    } catch (err) {
      // Never let one bad sweep end the schedule: the next tick is the retry.
      logger.error(`Health sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => void runNow(), intervalMinutes * 60_000);
  // A sweep must never be the reason the process stays up.
  timer.unref?.();
  logger.info(`Health sweep scheduled every ${intervalMinutes} minute(s)`);

  return {
    stop: () => clearInterval(timer),
    runNow,
  };
};
