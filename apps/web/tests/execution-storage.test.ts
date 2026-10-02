import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImportedExecution } from "@luxalgo/journal-importers";

const originalDir = process.env.JOURNAL_DATA_DIR;
const scratch = mkdtempSync(join(tmpdir(), "journal-storage-test-"));
process.env.JOURNAL_DATA_DIR = scratch;
const { db, accounts, executions, trades, ensureDb, libsql } = await import("../src/db");
const { insertExecutions } = await import("../src/server/executions");
const { rebuildAccount } = await import("../src/server/rebuild");
const { POST } = await import("../src/app/api/executions/route");
const { GET: getTrade } = await import("../src/app/api/trades/[key]/route");
const rows: ImportedExecution[] = [
  {
    symbol: "TEST",
    side: "buy",
    quantity: 10,
    price: 100,
    fee: 0,
    executedAt: "2026-09-01T10:00:00Z",
  },
  {
    symbol: "TEST",
    side: "sell",
    quantity: 10,
    price: 102,
    fee: 0,
    executedAt: "2026-09-01T11:00:00Z",
  },
];

beforeEach(async () => {
  await ensureDb();
  vi.stubEnv("JOURNAL_PASSWORD", "");
  await db.delete(trades).run();
  await db.delete(executions).run();
  await db.delete(accounts).run();
  await db.insert(accounts)
    .values({ id: "test", name: "Test", kind: "manual", createdAt: "2026-01-01" })
    .run();
});
afterAll(async () => {
  vi.unstubAllEnvs();
  if (originalDir === undefined) delete process.env.JOURNAL_DATA_DIR;
  else process.env.JOURNAL_DATA_DIR = originalDir;
  rmSync(scratch, { recursive: true, force: true });
});

describe("execution storage preserves a coherent journal", () => {
  it("rejects missing accounts and invalid fills before inserting data", async () => {
    await expect(insertExecutions("missing", rows, "manual")).rejects.toThrow("Account not found");
    for (const invalid of [
      { quantity: Infinity },
      { quantity: 0 },
      { fee: NaN },
      { executedAt: "invalid" },
      { side: "hold" },
      { symbol: " " },
    ]) {
      await expect(insertExecutions(
          "test",
          [rows[0]!, { ...rows[1]!, ...invalid } as ImportedExecution],
          "manual",
        )).rejects.toThrow();
    }
    expect(await db.select().from(executions).all()).toHaveLength(0);
  });

  it("rolls back the fills if calculating their trades fails", async () => {
    await libsql.execute(
      "CREATE TRIGGER fail_trade BEFORE INSERT ON trades BEGIN SELECT RAISE(FAIL, 'test storage failure'); END",
    );
    try {
      await expect(insertExecutions("test", rows, "manual")).rejects.toThrow();
      expect(await db.select().from(executions).all()).toHaveLength(0);
      expect(await db.select().from(trades).all()).toHaveLength(0);
    } finally {
      await libsql.execute("DROP TRIGGER fail_trade");
    }
  });

  it("deduplicates repeated imports while keeping the calculated total", async () => {
    expect(await insertExecutions("test", rows, "manual")).toMatchObject({ inserted: 2, duplicates: 0 });
    expect(await insertExecutions("test", rows, "manual")).toMatchObject({ inserted: 0, duplicates: 2 });
    expect(await db.select().from(executions).all()).toHaveLength(2);
    expect((await db.select().from(trades).all())[0]?.netPnl).toBe(20);
  });

  it("saves Markdown notes with manual trades and preserves them through a rebuild and retry", async () => {
    const notes = "## Setup\n\nWaited for **confirmation**.\n- Followed the plan.";
    const response = await POST(
      new Request("http://localhost/api/executions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: "test", executions: rows, notes }),
      }),
    );
    expect(response.status).toBe(200);
    const trade = (await db.select().from(trades).get())!;
    const detail = await getTrade(new Request("http://localhost/api/trades/fixture"), {
      params: Promise.resolve({ key: trade.key }),
    });
    expect((await detail.json()).trade.notes).toBe(notes);
    await rebuildAccount("test");
    expect(await insertExecutions("test", rows, "manual", notes)).toMatchObject({
      inserted: 0,
      duplicates: 2,
    });
    expect((await db.select().from(trades).get())?.notes).toBe(notes);
  });

  it("appends exit notes to the correct position without changing unrelated trade notes", async () => {
    await insertExecutions("test", [rows[0]!], "manual", "Entry plan");
    await insertExecutions(
      "test",
      rows.map((row) => ({ ...row, symbol: "OTHER" })),
      "manual",
      "Unrelated note",
    );
    await insertExecutions("test", [rows[1]!], "manual", "Exit review");
    const saved = await db.select().from(trades).all();
    expect(saved.find((row) => row.symbol === "TEST")).toMatchObject({
      notes: "Entry plan\n\nExit review",
      netPnl: 20,
    });
    expect(saved.find((row) => row.symbol === "OTHER")?.notes).toBe("Unrelated note");
  });

  it("keeps existing notes when a manual exit has no notes", async () => {
    await insertExecutions("test", [rows[0]!], "manual", "Keep this plan");
    await insertExecutions("test", [rows[1]!], "manual", "   ");
    expect((await db.select().from(trades).get())?.notes).toBe("Keep this plan");
  });

  it("saves notes for an already-recorded trade without duplicating fills or repeated notes", async () => {
    await insertExecutions("test", rows, "manual", "Entry plan");
    expect(await insertExecutions("test", rows, "manual", "Later review")).toMatchObject({
      inserted: 0,
      duplicates: 2,
    });
    await insertExecutions("test", rows, "manual", "Later review");
    expect(await db.select().from(executions).all()).toHaveLength(2);
    expect((await db.select().from(trades).get())?.notes).toBe("Entry plan\n\nLater review");
  });

  it("attaches a batch note to each trade formed by its new executions", async () => {
    await insertExecutions(
      "test",
      [
        ...rows,
        ...rows.map((row) => ({ ...row, executedAt: row.executedAt.replace("09-01", "09-02") })),
      ],
      "manual",
      "Session review",
    );
    const saved = await db.select().from(trades).all();
    expect(saved).toHaveLength(2);
    expect(saved.every((row) => row.notes === "Session review")).toBe(true);
  });

  it("rejects invalid notes before inserting executions", async () => {
    for (const notes of [null, 42, {}, ["note"], "a".repeat(100001)]) {
      const response = await POST(
        new Request("http://localhost/api/executions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accountId: "test", executions: rows, notes }),
        }),
      );
      expect(response.status).toBe(400);
    }
    expect(await db.select().from(executions).all()).toHaveLength(0);
    expect(await db.select().from(trades).all()).toHaveLength(0);
  });

  it("rolls back new executions if appending notes exceeds the existing notes limit", async () => {
    const existing = "a".repeat(100000);
    await insertExecutions("test", [rows[0]!], "manual", existing);
    await expect(insertExecutions("test", [rows[1]!], "manual", "Exit review")).rejects.toThrow(
      "Combined trade notes",
    );
    expect(await db.select().from(executions).all()).toHaveLength(1);
    expect(await db.select().from(trades).get()).toMatchObject({ notes: existing, status: "open" });
  });
});
