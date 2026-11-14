import { describe, expect, it } from "vitest";
import { createLimit } from "./limit.ts";

/** A signal nothing fires, for the tests that only need a slot. */
const never = () => new AbortController().signal;

describe("a render limit", () => {
  it("hands out its maximum at once, and gives the next slot to the render that waited", async () => {
    const limit = createLimit(2);
    const first = await limit.acquire(never());
    const second = await limit.acquire(never());

    const waiting = limit.acquire(never());
    const granted: string[] = [];
    const third = waiting.then((release) => {
      granted.push("third");
      return release;
    });
    await Promise.resolve();
    expect(granted).toEqual([]);

    first();
    const thirdRelease = await third;
    expect(granted).toEqual(["third"]);

    second();
    thirdRelease();
    // Every slot is back, so two more renders take them without waiting.
    const fourth = await limit.acquire(never());
    const fifth = await limit.acquire(never());
    fourth();
    fifth();
  });

  it("passes a released slot to the renders in the order they arrived", async () => {
    const limit = createLimit(1);
    const only = await limit.acquire(never());
    const order: number[] = [];
    const second = limit.acquire(never()).then((release) => {
      order.push(2);
      return release;
    });
    const third = limit.acquire(never()).then((release) => {
      order.push(3);
      return release;
    });

    only();
    const secondRelease = await second;
    expect(order).toEqual([2]);
    secondRelease();
    const thirdRelease = await third;
    expect(order).toEqual([2, 3]);
    thirdRelease();
  });

  it("stops waiting when its signal fires, and leaves the slot for the next render", async () => {
    const limit = createLimit(1);
    const held = await limit.acquire(never());
    const stopped = new AbortController();
    const waiting = limit.acquire(stopped.signal);

    stopped.abort(new Error("the poll stopped"));
    await expect(waiting).rejects.toThrow("the poll stopped");

    // The render that gave up was never holding a slot, so the limit still holds exactly one.
    const next = limit.acquire(never());
    let granted = false;
    void next.then(() => {
      granted = true;
    });
    await Promise.resolve();
    expect(granted).toBe(false);

    held();
    const nextRelease = await next;
    nextRelease();
  });

  it("refuses a limit that can never grant a slot", () => {
    expect(() => createLimit(0)).toThrow(RangeError);
    expect(() => createLimit(1.5)).toThrow(RangeError);
  });
});
