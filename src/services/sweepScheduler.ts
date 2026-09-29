import { startScheduledTask, type Schedule } from './scheduler.js';
import { runHealthSweep, type HealthSweepSummary } from './healthSweep.js';

export type SweepSchedule = Schedule;

/**
 * Runs the health sweep on a timer.
 *
 * The sweep existed only as a route, so health, version, latency and sync state
 * were as fresh as the last time somebody pressed the button — which is why the
 * fleet page could report a store `up` from the day it was deployed, weeks after
 * it stopped answering. A control plane whose whole purpose is "is the fleet
 * okay" has to answer that on its own rather than from an old probe.
 *
 * The guards (skip a tick rather than queue it, nothing at boot, 0 disables)
 * live in `startScheduledTask`, shared with the billing tick.
 */
export const startHealthSweep = (
  intervalMinutes: number,
  sweep: () => Promise<HealthSweepSummary> = runHealthSweep,
): SweepSchedule | null =>
  startScheduledTask('health sweep', intervalMinutes, async () => {
    await sweep();
  });
