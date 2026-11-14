// A fixed number of renders may hold a browser at once, and the rest wait their turn (docs: Sources
// and ingestion, "The Chromium fallback"). The wait happens inside each render's own deadline, so a
// render that never gets a slot fails as a render timeout rather than as a connection error.

export interface Limit {
  /** Resolves with the slot's release once a slot is free; rejects with the signal's reason first. */
  acquire: (signal: AbortSignal) => Promise<() => void>;
}

/**
 * A limit of `max` slots. A waiting render is granted the slot a holder releases, in arrival order,
 * so no render that arrives while another waits can take it.
 */
export function createLimit(max: number): Limit {
  if (!Number.isInteger(max) || max < 1) {
    throw new RangeError(`A limit needs at least one slot, not ${String(max)}`);
  }
  let free = max;
  const waiting: { grant: () => void }[] = [];
  // A rejection carries an Error, and the reason a signal gives may be anything.
  const stopReason = (signal: AbortSignal) => {
    const reason: unknown = signal.reason;
    return reason instanceof Error ? reason : new Error(String(reason));
  };

  /** A held slot. Its release passes the slot to the next render in line, or puts it back. */
  const hold = (): (() => void) => {
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      const next = waiting.shift();
      if (next === undefined) free += 1;
      else next.grant();
    };
  };

  return {
    acquire: (signal) => {
      // A signal that has already fired stops the render before it holds anything.
      if (signal.aborted) return Promise.reject(stopReason(signal));
      if (free > 0) {
        free -= 1;
        return Promise.resolve(hold());
      }
      return new Promise<() => void>((resolve, reject) => {
        const abort = () => {
          const index = waiting.indexOf(slot);
          // Only a grant removes the render from the queue, and it stops listening first.
          if (index !== -1) waiting.splice(index, 1);
          reject(stopReason(signal));
        };
        const slot = {
          grant: () => {
            signal.removeEventListener("abort", abort);
            resolve(hold());
          },
        };
        waiting.push(slot);
        signal.addEventListener("abort", abort, { once: true });
      });
    },
  };
}
