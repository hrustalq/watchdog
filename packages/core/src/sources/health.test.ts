import { describe, expect, it } from "vitest";
import { type HealthState, healthAfter } from "./health.ts";

const created = new Date("2026-11-03T12:00:00Z");
const minutesLater = (minutes: number) => new Date(created.getTime() + minutes * 60_000);
const fresh: HealthState = { health: "ok", consecutiveFailures: 0, lastSuccessAt: null, createdAt: created };

/** The state after `count` failed polls in a row, a minute apart from `start`. */
function failing(count: number, from: HealthState = fresh, start = 1) {
  let state = from;
  for (let i = 0; i < count; i += 1) state = { ...state, ...healthAfter(state, { at: minutesLater(start + i), failed: true }) };
  return state;
}

describe("healthAfter", () => {
  it("stays ok through two failed polls and is degraded at the third", () => {
    expect(failing(2)).toMatchObject({ health: "ok", consecutiveFailures: 2 });
    expect(failing(3)).toMatchObject({ health: "degraded", consecutiveFailures: 3 });
  });

  it("stays degraded through nine failed polls and is failing at the tenth", () => {
    expect(failing(9)).toMatchObject({ health: "degraded", consecutiveFailures: 9 });
    expect(failing(10)).toMatchObject({ health: "failing", consecutiveFailures: 10 });
  });

  it("is ok after one success, with the count back at 0 and the success's time kept", () => {
    const at = minutesLater(30);
    expect(healthAfter(failing(12), { at, failed: false })).toEqual({
      health: "ok",
      consecutiveFailures: 0,
      lastSuccessAt: at,
    });
  });

  it("counts failures in a row only, so a success between them starts the count again", () => {
    const recovered = { ...fresh, ...healthAfter(failing(2), { at: minutesLater(3), failed: false }) };
    expect(failing(2, recovered, 4)).toMatchObject({ health: "ok", consecutiveFailures: 2 });
  });

  it("is failing on a failed poll 24 hours after the last success, however few failed", () => {
    const succeeded = { ...fresh, lastSuccessAt: minutesLater(60) };
    const justUnder = healthAfter(succeeded, { at: minutesLater(60 + 24 * 60 - 1), failed: true });
    expect(justUnder).toMatchObject({ health: "ok", consecutiveFailures: 1 });
    const dayLater = healthAfter(succeeded, { at: minutesLater(60 + 24 * 60), failed: true });
    expect(dayLater).toMatchObject({ health: "failing", consecutiveFailures: 1 });
  });

  it("counts the 24 hours from when a Source that never succeeded was created", () => {
    expect(healthAfter(fresh, { at: minutesLater(24 * 60 - 1), failed: true }).health).toBe("ok");
    expect(healthAfter(fresh, { at: minutesLater(24 * 60), failed: true }).health).toBe("failing");
  });

  it("keeps a failing Source failing on another failed poll, and its last success", () => {
    const lastSuccessAt = minutesLater(5);
    const lostAccess: HealthState = { ...fresh, health: "failing", lastSuccessAt };
    expect(healthAfter(lostAccess, { at: minutesLater(6), failed: true })).toEqual({
      health: "failing",
      consecutiveFailures: 1,
      lastSuccessAt,
    });
  });
});
