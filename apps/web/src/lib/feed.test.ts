import { describe, expect, it } from "vitest";
import { deliveryStatus, isActFailure, isCallFailure, isFailureRow, manualRunIn, parseCursor } from "./feed.ts";

const id = "0b6f2a4e-8c1d-4f3a-9e2b-7d5c6a1f0e9d";

describe("manualRunIn", () => {
  const captured = { id: 1, message: "Captured from Blog", data: {} };
  const worked = {
    id: 2,
    message: "Manual run: Extractor Rule Plans extracted plan",
    data: { manual: true, extractor: "Plans", fields: ["plan"], empty: [], problems: [] },
  };
  const failed = {
    id: 3,
    message: "Manual run: Extractor Rule Plans failed: The model is down",
    data: { manual: true, extractor: "Plans", reason: "error", detail: "The model is down", failed: true },
  };
  const later = { id: 4, message: "Rated", data: {} };

  it("finds the run the URL names, whether it failed, and what it did with each field", () => {
    expect(manualRunIn([captured, worked, later], "2")).toEqual({
      id: 2,
      message: "Manual run: Extractor Rule Plans extracted plan",
      failed: false,
      extractor: "Plans",
      fields: ["plan"],
      empty: [],
      problems: [],
      detail: undefined,
    });
    expect(manualRunIn([captured, failed], "3")).toEqual({
      id: 3,
      message: "Manual run: Extractor Rule Plans failed: The model is down",
      failed: true,
      extractor: "Plans",
      fields: [],
      empty: [],
      problems: [],
      detail: "The model is down",
    });
  });

  it("keeps the fields a run found empty and those it couldn't store, with their reasons", () => {
    const partial = {
      id: 5,
      message: "Manual run: Extractor Rule Plans extracted plan; found no value for author",
      data: {
        manual: true,
        extractor: "Plans",
        fields: ["plan"],
        empty: ["author"],
        problems: [{ name: "cve", reason: "no page HTML on this Item" }],
      },
    };
    expect(manualRunIn([partial], "5")).toMatchObject({
      fields: ["plan"],
      empty: ["author"],
      problems: [{ name: "cve", reason: "no page HTML on this Item" }],
    });
  });

  it("has no parts to show for a failure's reason, and nothing a row holds in another shape", () => {
    const old = { id: 6, message: "Manual run: Extractor Rule Plans failed: it was deleted", data: { manual: true, failed: true } };
    expect(manualRunIn([old], "6")).toMatchObject({ failed: true, extractor: undefined, detail: undefined, fields: [] });

    const odd = {
      id: 7,
      message: "Manual run",
      data: { manual: true, extractor: 3, fields: "plan", empty: [1, "cve"], problems: [null, { name: "cve" }, { name: 1, reason: 2 }] },
    };
    expect(manualRunIn([odd], "7")).toMatchObject({
      extractor: undefined,
      fields: [],
      empty: ["cve"],
      problems: [],
    });
  });

  it("ignores a run a newer one replaced, so a success can't sit above a later failure", () => {
    expect(manualRunIn([captured, worked, failed], "2")).toBeUndefined();
  });

  it("ignores a row that isn't a manual run, one not in this Log, and anything else", () => {
    const log = [captured, worked, later];
    expect(manualRunIn(log, "1")).toBeUndefined();
    expect(manualRunIn(log, "4")).toBeUndefined();
    expect(manualRunIn(log, "9")).toBeUndefined();
    expect(manualRunIn(log, ["2"])).toBeUndefined();
    expect(manualRunIn(log, undefined)).toBeUndefined();
  });
});

describe("parseCursor", () => {
  it("reads the sort keys of an Item with and without a published time", () => {
    expect(parseCursor(`2026-11-03T15:00:00.123456Z_2026-11-01T08:30:00.000000Z_${id}`)).toEqual({
      captured: "2026-11-03T15:00:00.123456Z",
      published: "2026-11-01T08:30:00.000000Z",
      id,
    });
    expect(parseCursor(`2026-11-03T15:00:00.123456Z_-infinity_${id}`)).toEqual({
      captured: "2026-11-03T15:00:00.123456Z",
      published: "-infinity",
      id,
    });
  });

  it.each([
    ["no cursor", undefined],
    ["a repeated parameter", ["a", "b"]],
    ["a bare Item id", id],
    ["a day that doesn't exist", `2026-02-30T00:00:00.000000Z_-infinity_${id}`],
    ["a month that doesn't exist", `2026-13-01T00:00:00.000000Z_-infinity_${id}`],
    ["year 0, which Postgres refuses", `0000-01-01T00:00:00.000000Z_-infinity_${id}`],
    ["a time without microseconds", `2026-11-03T15:00:00Z_-infinity_${id}`],
    ["a captured time of -infinity", `-infinity_-infinity_${id}`],
    ["an id that isn't a uuid", "2026-11-03T15:00:00.123456Z_-infinity_x"],
    ["an extra part", `2026-11-03T15:00:00.123456Z_-infinity_${id}_x`],
    ["SQL", `2026-11-03T15:00:00.123456Z_'); drop table item; --_${id}`],
  ])("rejects %s", (_, value) => {
    expect(parseCursor(value)).toBeUndefined();
  });
});

describe("deliveryStatus", () => {
  const at = new Date("2026-11-07T13:30:00Z");
  const base = { status: "queued" as const, attempts: 0, nextAttemptAt: null, lastError: null };

  it("says a Delivery waiting for its first send is queued, and a sent one sent", () => {
    expect(deliveryStatus(base, "UTC")).toEqual({ text: "Queued", failed: false });
    expect(deliveryStatus({ ...base, status: "sent", attempts: 1 }, "UTC")).toEqual({ text: "Sent", failed: false });
  });

  it("gives held and grouped Deliveries their time in the Workspace timezone", () => {
    expect(deliveryStatus({ ...base, status: "held", nextAttemptAt: at }, "Europe/Berlin")).toEqual({
      text: "Held until 2026-11-07 14:30 Europe/Berlin",
      failed: false,
    });
    expect(deliveryStatus({ ...base, status: "grouped", nextAttemptAt: at }, "UTC")).toEqual({
      text: "Grouped, goes at 2026-11-07 13:30 UTC",
      failed: false,
    });
  });

  it("names a failed attempt's reason and the next retry, and says when there are no more", () => {
    const failing = { ...base, attempts: 2, nextAttemptAt: at, lastError: "the receiver answered 500" };
    expect(deliveryStatus(failing, "UTC")).toEqual({
      text: "Failed: the receiver answered 500. Next retry at 2026-11-07 13:30 UTC",
      failed: true,
    });
    // The Log writes the same retry the same way, from the same formatter.
    expect(deliveryStatus(failing, "Europe/Berlin")).toEqual({
      text: "Failed: the receiver answered 500. Next retry at 2026-11-07 14:30 Europe/Berlin",
      failed: true,
    });
    expect(deliveryStatus({ ...failing, status: "failed", nextAttemptAt: null, lastError: "refused." }, "UTC")).toEqual({
      text: "Failed: refused. No more retries",
      failed: true,
    });
  });

  it("says a retry released from a hold is queued, because it goes now", () => {
    const released = { ...base, attempts: 1, lastError: "the receiver answered 500" };
    expect(deliveryStatus(released, "UTC")).toEqual({ text: "Queued", failed: false });
  });
});

describe("isActFailure", () => {
  it("is true for a failed send's Log row and false for every other row", () => {
    const row = (stage: string, data: unknown) => ({ stage, data });
    expect(isActFailure(row("act", { attempt: 1, retryAt: "2026-11-07T13:30:00.000Z" }))).toBe(true);
    expect(isActFailure(row("act", { attempt: 9, final: true }))).toBe(true);
    expect(isActFailure(row("act", { attempt: 1 }))).toBe(false);
    expect(isActFailure(row("act", { heldUntil: "2026-11-07T13:30:00.000Z" }))).toBe(false);
    expect(isActFailure(row("rate", { final: true }))).toBe(false);
    expect(isActFailure(row("act", null))).toBe(false);
  });
});

describe("isFailureRow", () => {
  const row = (stage: string, data: unknown) => ({ stage, data });

  it("is true for a failed call, a failed manual run and a failed send", () => {
    expect(isFailureRow(row("rate", { reason: "invalid_output" }))).toBe(true);
    expect(isFailureRow(row("classify", { reason: "error" }))).toBe(true);
    expect(isFailureRow(row("extract", { extractor: "pricing", manual: true, failed: true }))).toBe(true);
    expect(isFailureRow(row("act", { attempt: 1, retryAt: "2026-11-07T13:30:00.000Z" }))).toBe(true);
    // A Digest that went to one Destination and failed at another says so with `reason` alone.
    expect(isFailureRow(row("act", { digest: "failed", reason: "the receiver answered 500", final: true }))).toBe(true);
  });

  it("is false for a row that worked, a row with no data, and data that isn't an object", () => {
    expect(isFailureRow(row("rate", { severity: 4, importance: 3 }))).toBe(false);
    expect(isFailureRow(row("capture", {}))).toBe(false);
    expect(isFailureRow(row("rate", null))).toBe(false);
    expect(isFailureRow(row("rate", undefined))).toBe(false);
    expect(isFailureRow(row("act", { digest: "sent" }))).toBe(false);
  });
});

describe("isCallFailure", () => {
  const row = (stage: string, data: unknown) => ({ stage, data });

  it("is true only for a failed model call, which the Model screen fixes", () => {
    expect(isCallFailure(row("rate", { reason: "invalid_output" }))).toBe(true);
    expect(isCallFailure(row("classify", { reason: "unreadable_key" }))).toBe(true);
    expect(isCallFailure(row("extract", { manual: true, failed: true, reason: "invalid_output" }))).toBe(true);
    expect(isCallFailure(row("extract", { manual: true, failed: true }))).toBe(false);
    expect(isCallFailure(row("act", { attempt: 1, retryAt: "2026-11-07T13:30:00.000Z" }))).toBe(false);
    expect(isCallFailure(row("act", { digest: "failed", reason: "the receiver answered 500", final: true }))).toBe(false);
    expect(isCallFailure(row("rate", {}))).toBe(false);
  });
});
