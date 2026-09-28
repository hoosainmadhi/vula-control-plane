import { startHealthSweep } from '../services/sweepScheduler.js';
import type { HealthSweepSummary } from '../services/healthSweep.js';

/**
 * The scheduled sweep, which exists so the panel can answer "is the fleet okay"
 * from a fresh probe instead of from whenever somebody last clicked.
 *
 * The interesting behaviour is not that it repeats — it is what it does when a
 * sweep is slow, when one throws, and when it is switched off, because those are
 * the cases that decide whether a control plane goes quiet without saying so.
 */

const summary: HealthSweepSummary = {
  storesChecked: 0,
  panelsChecked: 0,
  upCount: 0,
  downCount: 0,
  licencesRefreshed: 0,
  licenceFailures: 0,
  errors: [],
};

const MINUTE = 60_000;

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('startHealthSweep', () => {
  it('sweeps once per interval, and not at boot', async () => {
    const sweep = jest.fn().mockResolvedValue(summary);
    const schedule = startHealthSweep(10, sweep)!;

    // Booting is not a reason to probe the whole fleet: a restart loop must not
    // turn into a fleet-wide hammering.
    expect(sweep).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(10 * MINUTE);
    expect(sweep).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(20 * MINUTE);
    expect(sweep).toHaveBeenCalledTimes(3);

    schedule.stop();
  });

  it('skips a tick while the previous sweep is still running, then resumes', async () => {
    let release: () => void = () => {};
    const sweep = jest.fn(
      () =>
        new Promise<HealthSweepSummary>((resolve) => {
          release = () => resolve(summary);
        }),
    );
    const schedule = startHealthSweep(1, sweep)!;

    await jest.advanceTimersByTimeAsync(MINUTE);
    expect(sweep).toHaveBeenCalledTimes(1);

    // Two intervals pass while the first sweep is still in flight. Queuing them
    // would stack network calls behind a slow fleet; skipping keeps one in flight.
    await jest.advanceTimersByTimeAsync(2 * MINUTE);
    expect(sweep).toHaveBeenCalledTimes(1);

    release();
    await jest.advanceTimersByTimeAsync(MINUTE);
    expect(sweep).toHaveBeenCalledTimes(2);

    schedule.stop();
  });

  it('keeps going when a sweep throws', async () => {
    const sweep = jest
      .fn()
      .mockRejectedValueOnce(new Error('registry unavailable'))
      .mockResolvedValue(summary);
    const schedule = startHealthSweep(1, sweep)!;

    await jest.advanceTimersByTimeAsync(MINUTE);
    await jest.advanceTimersByTimeAsync(MINUTE);

    // The next tick is the retry — one failure must not end the schedule.
    expect(sweep).toHaveBeenCalledTimes(2);

    schedule.stop();
  });

  it('can be switched off, and says nothing is scheduled', () => {
    expect(startHealthSweep(0, jest.fn())).toBeNull();
    expect(startHealthSweep(-15, jest.fn())).toBeNull();
    // A typo in the variable must not read as "enabled with a strange interval".
    expect(startHealthSweep(Number.NaN, jest.fn())).toBeNull();
  });

  it('stops on demand', async () => {
    const sweep = jest.fn().mockResolvedValue(summary);
    const schedule = startHealthSweep(1, sweep)!;

    await jest.advanceTimersByTimeAsync(MINUTE);
    expect(sweep).toHaveBeenCalledTimes(1);

    schedule.stop();
    await jest.advanceTimersByTimeAsync(5 * MINUTE);
    expect(sweep).toHaveBeenCalledTimes(1);
  });

  it('runs a sweep on request, through the same guard', async () => {
    const sweep = jest.fn().mockResolvedValue(summary);
    const schedule = startHealthSweep(10, sweep)!;

    await schedule.runNow();
    expect(sweep).toHaveBeenCalledTimes(1);

    schedule.stop();
  });
});
