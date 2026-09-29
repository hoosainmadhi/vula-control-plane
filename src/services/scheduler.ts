import { logger } from '../utils/logger.js';

export interface Schedule {
  /** Cancels the schedule. Safe to call more than once. */
  stop(): void;
  /** Runs the task now, through the same in-flight guard. */
  runNow(): Promise<void>;
}

/**
 * Runs a task on a fixed interval — the shared shape for this server's
 * scheduled work (the health sweep, the billing tick).
 *
 * Two behaviours, both learned the hard way and both worth having once rather
 * than per job:
 *
 *  - **A tick is skipped, never queued, while the previous run is still in
 *    flight.** A slow fleet makes a sweep slow; stacking runs behind each other
 *    would turn that into a growing queue of network calls against the same
 *    stores.
 *  - **The first run is one interval after boot, not at boot.** A restart loop
 *    (this repo has had one) must not become a reason to hammer every deployment
 *    or raise a round of invoices.
 *
 * An interval of 0, or a value that is not a positive number, disables the
 * schedule and says so once.
 */
export const startScheduledTask = (
  label: string,
  intervalMinutes: number,
  run: () => Promise<void>,
): Schedule | null => {
  if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
    logger.info(
      `Scheduled ${label} is off (interval is 0 or unusable) — it will only run when asked by hand`,
    );
    return null;
  }

  let inFlight = false;

  const runNow = async (): Promise<void> => {
    if (inFlight) {
      logger.warn(`A ${label} is still running — skipping this tick rather than queuing`);
      return;
    }
    inFlight = true;
    try {
      await run();
    } catch (err) {
      // Never let one bad run end the schedule: the next tick is the retry.
      logger.error(`${label} failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => void runNow(), intervalMinutes * 60_000);
  // A scheduled task must never be the reason the process stays up.
  timer.unref?.();
  logger.info(`Scheduled ${label} every ${intervalMinutes} minute(s)`);

  return {
    stop: () => clearInterval(timer),
    runNow,
  };
};
