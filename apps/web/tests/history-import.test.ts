import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { eq } from "drizzle-orm";
import { parseHistory } from "@luxalgo/journal-importers";
import { BOOTSTRAP_SQL } from "../src/db/bootstrap";
import { decodeImportFile } from "../src/lib/decode-import";

const originalDir = process.env.JOURNAL_DATA_DIR;
const scratch = mkdtempSync(join(tmpdir(), "journal-history-test-"));
process.env.JOURNAL_DATA_DIR = scratch;
// Exercise upgrading an existing database, not only creation of a fresh schema.
const oldDb = createClient({ url: `file:${join(scratch, "journal.db")}` });
await oldDb.executeMultiple(
  BOOTSTRAP_SQL.split("CREATE TABLE IF NOT EXISTS import_sources")[0]!.replace(
    "  import_metadata_json TEXT,\n",
    "",
  ),
);
await oldDb.execute(
  "INSERT INTO accounts(id,name,kind,created_at) VALUES ('legacy','Existing','manual','2026-01-01')",
);
oldDb.close();
const { db, accounts, executions, trades, settings, ensureDb, libsql } = await import("../src/db");
await ensureDb();
const { insertExecutions } = await import("../src/server/executions");
const { rebuildAccount } = await import("../src/server/rebuild");
const { POST: importRoute } = await import("../src/app/api/import/route");
const post = async (body: object) =>
  importRoute(
    new Request("http://localhost/api/import", { method: "POST", body: JSON.stringify(body) }),
  );
// A TradingView strategy export: auto-detected, trade-level, two identical positions.
const csv = `Symbol;FX:EURUSD
Trade #;Type;Date/Time;Price;Contracts;Profit;Profit %
1;Entry long;2026-01-05 09:00;1.1;0.1;18.5;1
1;Exit long;2026-01-05 10:00;1.102;0.1;18.5;1
2;Entry long;2026-01-05 09:00;1.1;0.1;18.5;1
2;Exit long;2026-01-05 10:00;1.102;0.1;18.5;1`;
beforeEach(async () => {
  await ensureDb();
  await db.delete(trades).run();
  await db.delete(executions).run();
  await db.delete(settings).run();
  await db.delete(accounts).where(eq(accounts.id, "test")).run();
  await db.insert(accounts)
    .values({ id: "test", name: "Test", kind: "import", createdAt: "2026-01-01" })
    .run();
});
afterAll(() => {
  if (originalDir === undefined) delete process.env.JOURNAL_DATA_DIR;
  else process.env.JOURNAL_DATA_DIR = originalDir;
  rmSync(scratch, { recursive: true, force: true });
});

describe("history imports use the existing preview, commit and rebuild pipeline", () => {
  it("adds storage metadata to an existing database without removing its account", async () => {
    for (const table of ["import_sources", "import_source_aliases", "import_batches"]) {
      expect(
        (
          await libsql.execute({
            sql: "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
            args: [table],
          })
        ).rows[0],
      ).toBeTruthy();
    }
    expect((await db.select().from(accounts).where(eq(accounts.id, "legacy")).get())?.name).toBe(
      "Existing",
    );
    expect(
      (await libsql.execute("PRAGMA table_info(executions)")).rows.some(
        (c) => String(c.name) === "import_metadata_json",
      ),
    ).toBe(true);
  });
  it("previews without writes, commits once, and preserves separate positions and annotations on rebuild", async () => {
    const preview = await post({ mode: "preview", content: csv });
    expect(preview.status).toBe(200);
    expect((await preview.json()).totals.executions).toBe(4);
    expect(await db.select().from(executions).all()).toHaveLength(0);
    const first = await post({ mode: "commit", content: csv, accountId: "test" });
    expect((await first.json()).inserted).toBe(4);
    expect(await db.select().from(trades).all()).toHaveLength(2);
    const saved = (await db.select().from(trades).all())[0]!;
    await db.update(trades)
      .set({ notes: "User-owned note", rating: 5 })
      .where(eq(trades.key, saved.key))
      .run();
    const second = await post({ mode: "commit", content: csv, accountId: "test" });
    expect(await second.json()).toMatchObject({ inserted: 0, duplicates: 4 });
    await rebuildAccount("test");
    expect(await db.select().from(trades).where(eq(trades.key, saved.key)).get()).toMatchObject({
      netPnl: 18.5,
      notes: "User-owned note",
      rating: 5,
    });
  });
  it("retains legitimately identical generic fills and deduplicates reimports", async () => {
    const content = `Timestamp,Ticker,Buy/Sell,Fill Quantity,Execution Price
2026-01-05 09:00,AAPL,buy,1,100
2026-01-05 09:00,AAPL,buy,1,100
2026-01-05 10:00,AAPL,sell,2,101`;
    const parsed = await parseHistory(content, { adapterId: "generic-csv" })!;
    expect(await insertExecutions("test", parsed.executions, "import")).toMatchObject({
      inserted: 3,
      duplicates: 0,
    });
    expect(await insertExecutions("test", parsed.executions, "import")).toMatchObject({
      inserted: 0,
      duplicates: 3,
    });
    expect((await db.select().from(trades).all())[0]).toMatchObject({ quantity: 2, netPnl: 2 });
  });
  it("blocks missing-symbol commits and uses the same supplied symbol in preview and commit", async () => {
    const content = `Trade #,Type,Date/Time,Price,Contracts,Profit
1,Entry long,2026-01-05 09:00,100,1,1
1,Exit long,2026-01-05 10:00,101,1,1`;
    expect((await (await post({ mode: "preview", content })).json()).needsSymbol).toBe(true);
    expect((await post({ mode: "commit", content, accountId: "test" })).status).toBe(400);
    expect(await db.select().from(executions).all()).toHaveLength(0);
    const preview = await (await post({ mode: "preview", content, symbol: "AAPL" })).json();
    expect(preview.executions.every((e: { symbol: string }) => e.symbol === "AAPL")).toBe(true);
    expect(
      (await post({ mode: "commit", content, symbol: "AAPL", accountId: "test" })).status,
    ).toBe(200);
    expect((await db.select().from(trades).all())[0]?.symbol).toBe("AAPL");
  });
  it("does not replace reported zero fees or P&L with account defaults or multiplier recalculations", async () => {
    await db.insert(settings)
      .values({
        key: "journalDefaults",
        value: JSON.stringify({
          feeRules: [{ id: "fee", accountId: "test", symbol: "", amount: 5, mode: "execution" }],
        }),
      })
      .run();
    await db.insert(settings)
      .values({ key: "multipliers", value: JSON.stringify({ AAPL: 100 }) })
      .run();
    const parsed = await parseHistory(
      `Position,Symbol,Direction,Open Time,Close Time,Entry Price,Exit Price,Quantity,PnL,Fees
1,AAPL,long,2026-01-05 09:00,2026-01-05 10:00,100,101,1,1,0`,
      { adapterId: "generic-csv" },
    )!;
    await insertExecutions("test", parsed.executions, "import");
    await rebuildAccount("test");
    expect((await db.select().from(trades).all())[0]).toMatchObject({ netPnl: 1, fees: 0, grossPnl: 1 });
  });

  it("retains the mapped import through both preview and commit", async () => {
    const content = "When,Ticker,Way,Amount,Cost\n2026-01-05 09:00,AAPL,bought,2,100";
    const mapping = {
      timestamp: "When",
      symbol: "Ticker",
      side: "Way",
      quantity: "Amount",
      price: "Cost",
    };
    expect(
      (await (await post({ mode: "preview", content, mapping })).json()).totals.executions,
    ).toBe(1);
    expect(
      await (await post({ mode: "commit", content, mapping, accountId: "test" })).json(),
    ).toMatchObject({ inserted: 1 });
  });
});

describe("file decoding", () => {
  it("reads UTF-8, UTF-16LE and UTF-16BE without damaging non-ASCII text", async () => {
    const value = "<html>EURUSD 日本語</html>";
    const utf8 = new TextEncoder().encode(value);
    const le = Buffer.from("\ufeff" + value, "utf16le");
    const be = Buffer.from(le).swap16();
    for (const bytes of [utf8, le, be]) {
      const buffer = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
      expect(decodeImportFile(buffer)).toBe(value);
    }
  });
});
