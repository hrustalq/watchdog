// What a Workspace's model calls add up to, as the Usage screen shows it (ADR 0008). Months are UTC
// and written `YYYY-MM`. Every query is scoped to the Workspace.
import { agentCall, and, type Db, eq, gte, lt, modelConfig, type SQL, sql } from "@watchdog/db";

const monthStart = (month: string) => new Date(`${month}-01T00:00:00.000Z`);

const monthOf = (at: Date) => at.toISOString().slice(0, 7);

export function shiftMonth(month: string, by: number) {
  const date = monthStart(month);
  date.setUTCMonth(date.getUTCMonth() + by);
  return monthOf(date);
}

/** The month a URL asks for. Anything but a real month up to `now` means the current one. */
export function parseMonth(value: unknown, now: Date) {
  const current = monthOf(now);
  return typeof value === "string" && /^20\d{2}-(0[1-9]|1[0-2])$/.test(value) && value <= current ? value : current;
}

export const monthLabel = (month: string) =>
  new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(monthStart(month));

/** Prices have no currency, so neither does this. A cost too small to show still isn't nothing. */
export const formatCost = (cost: number) =>
  cost > 0 && cost < 0.0001
    ? "<0.0001"
    : cost.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 });

export const purposeLabel: Record<(typeof agentCall.$inferSelect)["purpose"], string> = {
  classify: "Classify",
  "extract-rate": "Extract and rate",
  "compile-rule": "Compile a rule",
  "draft-profile": "Draft a Profile",
  "test-connection": "Test connection",
};

export interface UsageTally {
  /** Every attempt, a failed or repaired one included. */
  calls: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  /** Calls missing a token count, whose tokens the totals can't include. */
  withoutTokens: number;
  /** Calls on a model without both prices, whose cost `cost` can't include. */
  unpricedCalls: number;
  /** What the priced calls cost. Null when none of them were. */
  cost: number | null;
}

const add = (a: UsageTally, b: UsageTally): UsageTally => ({
  calls: a.calls + b.calls,
  failed: a.failed + b.failed,
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  withoutTokens: a.withoutTokens + b.withoutTokens,
  unpricedCalls: a.unpricedCalls + b.unpricedCalls,
  cost: a.cost === null && b.cost === null ? null : (a.cost ?? 0) + (b.cost ?? 0),
});

/** One row per key, largest first. Other fields come from the key's first row, so read only what the key decides. */
function rollUp<Row extends UsageTally>(rows: Row[], keyOf: (row: Row) => string) {
  const groups = new Map<string, Row>();
  for (const row of rows) {
    const seen = groups.get(keyOf(row));
    groups.set(keyOf(row), seen === undefined ? row : { ...seen, ...add(seen, row) });
  }
  const tokens = (row: Row) => row.inputTokens + row.outputTokens;
  return [...groups.values()].toSorted((a, b) => tokens(b) - tokens(a) || b.calls - a.calls);
}

const count = (filter: SQL) => sql<number>`count(*) filter (where ${filter})`.mapWith(Number);
const sum = (column: typeof agentCall.inputTokens | typeof agentCall.outputTokens) => sql<number>`coalesce(sum(${column}), 0)`.mapWith(Number);

/**
 * A month's usage per model, an archived one included, and per purpose. `firstMonth` is the
 * Workspace's earliest month with a call, or undefined when it has never made one.
 */
export async function usageForMonth(db: Db, workspaceId: string, month: string) {
  const [counted, [first]] = await Promise.all([
    db
      .select({
        id: modelConfig.id,
        modelName: modelConfig.modelName,
        baseUrl: modelConfig.baseUrl,
        archived: sql<boolean>`${modelConfig.archivedAt} is not null`,
        inputPrice: modelConfig.inputPricePerMillion,
        outputPrice: modelConfig.outputPricePerMillion,
        purpose: agentCall.purpose,
        calls: sql<number>`count(*)`.mapWith(Number),
        failed: count(sql`${agentCall.status} <> 'ok'`),
        inputTokens: sum(agentCall.inputTokens),
        outputTokens: sum(agentCall.outputTokens),
        withoutTokens: count(sql`${agentCall.inputTokens} is null or ${agentCall.outputTokens} is null`),
      })
      .from(agentCall)
      .innerJoin(modelConfig, eq(agentCall.modelConfigId, modelConfig.id))
      .where(
        and(
          eq(agentCall.workspaceId, workspaceId),
          gte(agentCall.createdAt, monthStart(month)),
          lt(agentCall.createdAt, monthStart(shiftMonth(month, 1))),
        ),
      )
      .groupBy(modelConfig.id, agentCall.purpose),
    db
      .select({ at: agentCall.createdAt })
      .from(agentCall)
      .where(eq(agentCall.workspaceId, workspaceId))
      .orderBy(agentCall.createdAt)
      .limit(1),
  ]);

  const rows = counted.map((row) =>
    row.inputPrice === null || row.outputPrice === null
      ? { ...row, unpricedCalls: row.calls, cost: null }
      : {
          ...row,
          unpricedCalls: 0,
          cost: (row.inputTokens * row.inputPrice + row.outputTokens * row.outputPrice) / 1_000_000,
        },
  );
  const nothing: UsageTally = {
    calls: 0,
    failed: 0,
    inputTokens: 0,
    outputTokens: 0,
    withoutTokens: 0,
    unpricedCalls: 0,
    cost: null,
  };
  return {
    models: rollUp(rows, (row) => row.id),
    purposes: rollUp(rows, (row) => row.purpose),
    total: rows.reduce<UsageTally>(add, nothing),
    firstMonth: first === undefined ? undefined : monthOf(first.at),
  };
}
