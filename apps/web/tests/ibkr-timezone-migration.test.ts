import { afterAll, expect, it, vi } from "vitest";
import { createClient } from "@libsql/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOOTSTRAP_SQL } from "../src/db/bootstrap";

const scratch = mkdtempSync(join(tmpdir(), "journal-ibkr-upgrade-"));
vi.stubEnv("JOURNAL_DATA_DIR", scratch);

const legacy = createClient({ url: `file:${join(scratch, "journal.db")}` });
await legacy.executeMultiple(BOOTSTRAP_SQL.replace("  ibkr_sync_time_zone TEXT,\n", ""));
await legacy.execute(
  "INSERT INTO accounts (id, name, kind, broker, created_at) VALUES ('old', 'Original history', 'sync', 'ibkr-flex', '2026-01-01')",
);
const pragma = await legacy.execute("PRAGMA table_info(accounts)");
expect(pragma.rows.some((column) => String(column.name) === "ibkr_sync_time_zone")).toBe(false);
const beforeResult = await legacy.execute("SELECT * FROM accounts");
const before = beforeResult.rows[0]!;
legacy.close();

const { db, accounts, ensureDb, libsql } = await import("../src/db");
await ensureDb();

it("adds nullable provenance to existing accounts without claiming their old timezone", async () => {
  const afterResult = await libsql.execute("SELECT * FROM accounts");
  const afterRow = afterResult.rows[0]! as Record<string, unknown>;
  const { ibkr_sync_time_zone, ...after } = afterRow;
  expect(ibkr_sync_time_zone).toBeNull();
  const beforeObj = Object.fromEntries(
    Object.entries(before as Record<string, unknown>).filter(([k]) => k !== "ibkr_sync_time_zone"),
  );
  expect(after).toEqual(beforeObj);
  expect((await db.select().from(accounts).get())?.ibkrSyncTimeZone).toBeNull();
});

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
});
