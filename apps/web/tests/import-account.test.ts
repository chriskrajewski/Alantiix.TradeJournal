import { afterAll, expect, it, vi , beforeAll} from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const previous = process.env.JOURNAL_DATA_DIR;
const scratch = mkdtempSync(join(tmpdir(), "journal-import-account-"));
process.env.JOURNAL_DATA_DIR = scratch;
vi.stubEnv("JOURNAL_PASSWORD", "");
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
const { POST, GET } = await import("../src/app/api/accounts/route");
const { db, executions, trades, ensureDb } = await import("../src/db");
const { insertExecutions } = await import("../src/server/executions");

beforeAll(async () => {
  await ensureDb();
});

it("creates an import destination with the chosen currency/balance and accepts fills under its returned id", async () => {
  const response = await POST(
    new Request("http://localhost/api/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Import verification",
        kind: "import",
        currency: "USD",
        initialBalance: 50000,
      }),
    }),
  );
  expect(response.status).toBe(200);
  const { id } = await response.json();
  const listed = await (await GET(new Request("http://localhost/api/accounts"))).json();
  expect(listed.accounts).toMatchObject([
    { id, name: "Import verification", kind: "import", currency: "USD", initialBalance: 50000 },
  ]);
  await insertExecutions(
    id,
    [
      {
        symbol: "TEST",
        side: "buy",
        quantity: 10,
        price: 100,
        fee: 0.35,
        executedAt: "2026-01-02T14:30:00Z",
        assetClass: "equity",
      },
      {
        symbol: "TEST",
        side: "sell",
        quantity: 10,
        price: 101,
        fee: 0.35,
        executedAt: "2026-01-02T15:30:00Z",
        assetClass: "equity",
      },
    ],
    "import",
  );
  expect(await db.select().from(executions).all()).toHaveLength(2);
  expect(await db.select().from(trades).all()).toMatchObject([
    { accountId: id, status: "win", netPnl: 9.3 },
  ]);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  if (previous === undefined) delete process.env.JOURNAL_DATA_DIR;
  else process.env.JOURNAL_DATA_DIR = previous;
  rmSync(scratch, { recursive: true, force: true });
});
