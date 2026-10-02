import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { formatTimestamp } from "../src/lib/timezone";

const scratch = mkdtempSync(join(tmpdir(), "journal-ibkr-timezone-"));
vi.stubEnv("JOURNAL_DATA_DIR", scratch);
vi.stubEnv("JOURNAL_PASSWORD", "");
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
const { db, accounts, executions, trades, settings, ensureDb, libsql } = await import("../src/db");
const { encryptJson, decryptJson } = await import("../src/server/crypto");
const { setSetting } = await import("../src/server/settings");
const { syncAccount } = await import("../src/server/sync");
const { insertExecutions } = await import("../src/server/executions");
const { POST: accountAction } = await import("../src/app/api/accounts/[id]/actions/route");
const { PATCH: patchAccount } = await import("../src/app/api/accounts/[id]/route");
const { POST: createAccount } = await import("../src/app/api/accounts/route");
const { GET: stats } = await import("../src/app/api/stats/route");
const { GET: tradeDetail } = await import("../src/app/api/trades/[key]/route");
const { POST: importFile } = await import("../src/app/api/import/route");

const credentials = { flexToken: "test-only", flexQueryId: "test-only" };
const request = (path: string, body?: unknown) =>
  new Request(
    `http://localhost/api/${path}`,
    body === undefined ? undefined : { method: "POST", body: JSON.stringify(body) },
  );
const action = (id: string, body: unknown) =>
  accountAction(request(`accounts/${id}/actions`, body), { params: Promise.resolve({ id }) });
const account = async (id = "ibkr") => (await db.select().from(accounts).where(eq(accounts.id, id)).get())!;
const addAccount = async (id: string, extra: Partial<typeof accounts.$inferInsert> = {}) =>
  await db
    .insert(accounts)
    .values({
      id,
      name: id,
      kind: "sync",
      broker: "ibkr-flex",
      credentialsEnc: encryptJson(credentials),
      createdAt: "2026-01-01",
      ...extra,
    })
    .run();
const xml = (times = ["20260918;085905", "20260918;100830"]) =>
  `<FlexQueryResponse><FlexStatement accountId="U_TEST"><EquitySummaryByReportDateInBase total="1000" />${times
    .map(
      (time, index) =>
        `<Trade symbol="TEST" buySell="${index % 2 ? "SELL" : "BUY"}" quantity="1" tradePrice="${100 + index * 2}" ibCommission="-1" dateTime="${time}" />`,
    )
    .join("")}</FlexStatement></FlexQueryResponse>`;
const sent = () =>
  new Response(
    "<FlexStatementResponse><Status>Success</Status><ReferenceCode>test</ReferenceCode></FlexStatementResponse>",
  );
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
const mockXml = (content = xml()) => {
  fetchMock = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.includes("/SendRequest?")) return sent();
    if (url.includes("/GetStatement?")) return new Response(content);
    throw new Error(`Unexpected network request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
};
const snapshot = async () => ({
  accounts: await db.select().from(accounts).all(),
  executions: await db.select().from(executions).all(),
  trades: await db.select().from(trades).all(),
});
const annotate = async () =>
  await db.update(trades).set({ notes: "Keep my review", rating: 4, tagsJson: '["entry"]' }).run();

beforeEach(async () => {
  await ensureDb();
  await db.delete(trades).run();
  await db.delete(executions).run();
  await db.delete(accounts).run();
  await db.delete(settings).run();
  await addAccount("ibkr");
  await setSetting("importTimeZone", "America/New_York");
  await setSetting("timeZone", "Europe/Rome");
  mockXml();
});
afterEach(async () => vi.unstubAllGlobals());
afterAll(async () => {
  vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
});

describe("IBKR HTTP connection through persisted journal APIs", () => {
  it("stores the complaint's exact UTC times and renders Rome times and analytics", async () => {
    expect(await syncAccount("ibkr")).toMatchObject({ inserted: 2, skipped: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((await account()).ibkrSyncTimeZone).toBe("America/New_York");
    const trade = (await db.select().from(trades).get())!;
    expect(trade).toMatchObject({
      openedAt: "2026-09-18T12:59:05.000Z",
      closedAt: "2026-09-18T14:08:30.000Z",
      netPnl: 0,
    });
    const detail = await (
      await tradeDetail(request("trades/test"), { params: Promise.resolve({ key: trade.key }) })
    ).json();
    expect(detail.executions.map((fill: { executedAt: string }) => fill.executedAt).sort()).toEqual(
      ["2026-09-18T12:59:05.000Z", "2026-09-18T14:08:30.000Z"],
    );
    expect(
      detail.executions
        .map((fill: { executedAt: string }) => formatTimestamp(fill.executedAt, detail.timeZone))
        .sort(),
    ).toEqual(["2026-09-18 14:59:05", "2026-09-18 16:08:30"]);
    const dashboard = await (await stats(request("stats?calYear=2026&calMonth=9"))).json();
    expect(dashboard.buckets.hour.find((bucket: { trades: number }) => bucket.trades > 0).key).toBe(
      "14",
    );
    await annotate();
    const history = await snapshot();
    await setSetting("timeZone", "Pacific/Kiritimati");
    expect(await syncAccount("ibkr")).toMatchObject({ inserted: 0, duplicates: 2 });
    expect((await snapshot()).executions).toEqual(history.executions);
    expect((await snapshot()).trades).toEqual(history.trades);
    expect((await (await stats(request("stats"))).json()).days[0].date).toBe("2026-09-19");
  });

  it.each([
    ["UTC", "20260918;085905", "2026-09-18T08:59:05.000Z"],
    ["America/New_York", "20260118;085905", "2026-01-18T13:59:05.000Z"],
    ["Europe/Rome", "20260918;085905", "2026-09-18T06:59:05.000Z"],
    ["Pacific/Kiritimati", "20260918;085905", "2026-09-17T18:59:05.000Z"],
    ["Asia/Kathmandu", "20260918;085905", "2026-09-18T03:14:05.000Z"],
    ["America/New_York", "20260918;085905Z", "2026-09-18T08:59:05.000Z"],
    ["Europe/Rome", "20260918;085905-04:00", "2026-09-18T12:59:05.000Z"],
  ])("persists %s statement times correctly", async (zone, raw, expected) => {
    await setSetting("importTimeZone", zone);
    mockXml(xml([raw]));
    await syncAccount("ibkr");
    expect((await db.select().from(executions).get())?.executedAt).toBe(expected);
  });

  it("captures the default once before fetching, even if settings change during fetch", async () => {
    fetchMock.mockImplementation(async (input) => {
      await setSetting("importTimeZone", "Europe/Rome");
      return String(input).includes("/SendRequest?") ? sent() : new Response(xml());
    });
    await syncAccount("ibkr");
    expect((await account()).ibkrSyncTimeZone).toBe("America/New_York");
    expect((await db.select().from(executions).get())?.executedAt).toBe("2026-09-18T12:59:05.000Z");
  });

  it("returns skipped warnings for gaps, repeated hours, invalid dates and suffixes on first connection", async () => {
    mockXml(
      xml([
        "20260308;023000",
        "20261101;013000",
        "20260230;080000",
        "20260918;085905 EST",
        "20260918;085905",
      ]),
    );
    const response = await createAccount(
      request("accounts", { name: "New IBKR", kind: "sync", broker: "ibkr-flex", credentials }),
    );
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.sync).toMatchObject({ inserted: 1, skipped: 4 });
    expect(result.sync.skippedReasons.join(" ")).toMatch(/daylight-saving/);
    expect((await account(result.id)).ibkrSyncTimeZone).toBe("America/New_York");
  });

  it("does not establish history provenance for an entirely unusable batch", async () => {
    mockXml(xml(["20260308;023000"]));
    expect(await syncAccount("ibkr")).toMatchObject({ inserted: 0, skipped: 1 });
    expect((await account()).ibkrSyncTimeZone).toBeNull();
  });

  it("keeps the working IBKR CSV import timezone path", async () => {
    const content =
      "ClientAccountID,Symbol,Buy/Sell,Quantity,TradePrice,Commission,Date/Time\nU_TEST,TEST,BUY,1,100,-1,20260918;085905";
    const response = await importFile(
      request("import", { mode: "commit", accountId: "ibkr", content }),
    );
    expect(response.status).toBe(200);
    expect(await db.select().from(executions).get()).toMatchObject({
      source: "import",
      executedAt: "2026-09-18T12:59:05.000Z",
    });
    expect((await account()).ibkrSyncTimeZone).toBeNull();
  });
});

describe("IBKR history cannot be silently mixed", () => {
  it.each([null, "Europe/Rome"])(
    "rejects history with provenance %s without writes or broker requests",
    async (zone) => {
      await syncAccount("ibkr");
      await annotate();
      await db.update(accounts).set({ ibkrSyncTimeZone: zone }).where(eq(accounts.id, "ibkr")).run();
      const before = await snapshot();
      fetchMock.mockClear();
      const response = await action("ibkr", { action: "sync" });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toMatch(/separate IBKR account/);
      expect(await snapshot()).toEqual(before);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("allows canonical timezone aliases and empty accounts to adopt a new timezone", async () => {
    await db.update(accounts).set({ ibkrSyncTimeZone: "Europe/Rome" }).run();
    await syncAccount("ibkr");
    await setSetting("importTimeZone", "US/Eastern");
    expect(await syncAccount("ibkr")).toMatchObject({ inserted: 0, duplicates: 2 });
    expect((await account()).ibkrSyncTimeZone).toBe("America/New_York");
  });

  it("rechecks after fetch so concurrent syncs cannot establish conflicting zones", async () => {
    const waiting: Array<(response: Response) => void> = [];
    fetchMock.mockImplementation((input) =>
      String(input).includes("/SendRequest?")
        ? Promise.resolve(sent())
        : new Promise((resolve) => waiting.push(resolve)),
    );
    const first = syncAccount("ibkr");
    await vi.waitFor(() => expect(waiting).toHaveLength(1));
    await setSetting("importTimeZone", "Europe/Rome");
    const second = syncAccount("ibkr").then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await vi.waitFor(() => expect(waiting).toHaveLength(2));
    waiting[0]!(new Response(xml()));
    await first;
    await annotate();
    const before = await snapshot();
    waiting[1]!(new Response(xml()));
    expect(await second).toMatchObject({
      error: expect.objectContaining({
        message: expect.stringMatching(/synced using America\/New_York/),
      }),
    });
    expect(await snapshot()).toEqual(before);
  }, 15_000);

  it("rolls back provenance and status together when trade persistence fails", async () => {
    const before = await snapshot();
    await libsql.execute(
      "CREATE TRIGGER fail_ibkr_trade BEFORE INSERT ON trades BEGIN SELECT RAISE(FAIL, 'test failure'); END",
    );
    try {
      await expect(syncAccount("ibkr")).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
    } finally {
      await libsql.execute("DROP TRIGGER fail_ibkr_trade");
    }
  });

  it("rejects invalid settings before fetching or writing", async () => {
    for (const zone of ["Mars/Olympus", "+01:00"]) {
      await setSetting("importTimeZone", zone);
      const before = await snapshot();
      await expect(syncAccount("ibkr")).rejects.toThrow(/IANA/);
      expect(await snapshot()).toEqual(before);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  it("does not allow changing the broker to bypass a legacy history guard", async () => {
    await syncAccount("ibkr");
    await db.update(accounts).set({ ibkrSyncTimeZone: null }).run();
    const before = await snapshot();
    expect(
      (
        await patchAccount(request("accounts/ibkr", { broker: "alpaca" }), {
          params: Promise.resolve({ id: "ibkr" }),
        })
      ).status,
    ).toBe(400);
    expect(await snapshot()).toEqual(before);
  });

  it("does not write a fetched result when the connection changes during fetch", async () => {
    fetchMock.mockImplementation(async (input) => {
      await db.update(accounts)
        .set({ credentialsEnc: encryptJson({ ...credentials, flexToken: "replacement" }) })
        .run();
      return String(input).includes("/SendRequest?") ? sent() : new Response(xml());
    });
    await expect(syncAccount("ibkr")).rejects.toThrow(/connection changed/);
    expect((await snapshot()).executions).toEqual([]);
    expect((await account()).lastSyncAt).toBeNull();
    expect((await account()).ibkrSyncTimeZone).toBeNull();
  });
});

describe("account transfer provenance", () => {
  it("does not allow another broker connection to dilute IBKR provenance", async () => {
    await syncAccount("ibkr");
    await addAccount("other", { broker: "alpaca" });
    const before = await snapshot();
    expect((await action("ibkr", { action: "transfer", toAccountId: "other" })).status).toBe(400);
    expect(await snapshot()).toEqual(before);
  });
  it.each(["legacy-source", "legacy-destination", "different-zone"])(
    "blocks %s without changing history or annotations",
    async (variant) => {
      await syncAccount("ibkr");
      await annotate();
      await addAccount("destination");
      if (variant !== "legacy-source") await syncAccount("destination");
      await db.update(accounts)
        .set({ ibkrSyncTimeZone: variant === "different-zone" ? "Europe/Rome" : null })
        .where(eq(accounts.id, variant === "legacy-source" ? "ibkr" : "destination"))
        .run();
      const before = await snapshot();
      const response = await action("ibkr", { action: "transfer", toAccountId: "destination" });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toMatch(/Cannot/);
      expect(await snapshot()).toEqual(before);
    },
  );

  it("preserves known provenance through a manual account and blocks a later incompatible transfer", async () => {
    await syncAccount("ibkr");
    await annotate();
    await addAccount("manual", { kind: "manual", broker: "", credentialsEnc: null });
    expect((await action("ibkr", { action: "transfer", toAccountId: "manual" })).status).toBe(200);
    expect((await account("manual")).ibkrSyncTimeZone).toBe("America/New_York");
    expect((await account()).ibkrSyncTimeZone).toBeNull();
    expect((await db.select().from(trades).get())?.notes).toBe("Keep my review");
    await setSetting("importTimeZone", "Europe/Rome");
    await syncAccount("ibkr");
    const before = await snapshot();
    expect((await action("manual", { action: "transfer", toAccountId: "ibkr" })).status).toBe(400);
    expect(await snapshot()).toEqual(before);
  });

  it("blocks unknown synced history arriving from a non-IBKR account", async () => {
    await addAccount("other", { broker: "alpaca" });
    await insertExecutions(
      "other",
      [
        {
          symbol: "TEST",
          side: "buy",
          quantity: 1,
          price: 100,
          fee: 0,
          executedAt: "2026-09-18T12:00:00Z",
        },
      ],
      "sync",
    );
    const before = await snapshot();
    expect((await action("other", { action: "transfer", toAccountId: "ibkr" })).status).toBe(400);
    expect(await snapshot()).toEqual(before);
  });

  it("allows same-zone history into an empty IBKR account and clears provenance with explicit clear", async () => {
    await syncAccount("ibkr");
    await addAccount("destination");
    expect((await action("ibkr", { action: "transfer", toAccountId: "destination" })).status).toBe(
      200,
    );
    expect((await account("destination")).ibkrSyncTimeZone).toBe("America/New_York");
    expect(await syncAccount("destination")).toMatchObject({ inserted: 0, duplicates: 2 });
    expect((await action("destination", { action: "clear" })).status).toBe(200);
    expect((await account("destination")).ibkrSyncTimeZone).toBeNull();
  });
});

it("retains non-IBKR timestamp handling and persists rotating Questrade credentials", async () => {
  await db.update(accounts)
    .set({ broker: "questrade", credentialsEnc: encryptJson({ refreshToken: "old-test" }) })
    .run();
  await setSetting("importTimeZone", "Mars/Olympus");
  const tokens: string[] = [];
  fetchMock.mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes("/oauth2/token?")) {
      tokens.push(new URL(url).searchParams.get("refresh_token")!);
      return Response.json({
        access_token: "test",
        refresh_token: "new-test",
        api_server: "https://mock.questrade.test/",
      });
    }
    if (url.endsWith("/accounts")) return Response.json({ accounts: [{ number: "TEST" }] });
    if (url.endsWith("/balances"))
      return Response.json({ combinedBalances: [{ currency: "CAD", totalEquity: 1000 }] });
    if (url.endsWith("/positions")) return Response.json({ positions: [] });
    if (url.includes("/activities?"))
      return Response.json({
        activities: [
          {
            type: "Trades",
            action: "Buy",
            symbol: "TEST",
            quantity: 1,
            price: 100,
            tradeDate: "2026-09-18T08:59:05-04:00",
          },
        ],
      });
    throw new Error(`Unexpected network request: ${url}`);
  });
  expect(await syncAccount("ibkr")).toMatchObject({ inserted: 1 });
  expect(decryptJson((await account()).credentialsEnc!)).toEqual({ refreshToken: "new-test" });
  expect(await syncAccount("ibkr")).toMatchObject({ inserted: 0, duplicates: 1 });
  expect(tokens).toEqual(["old-test", "new-test"]);
  expect((await db.select().from(executions).get())?.executedAt).toBe("2026-09-18T12:59:05.000Z");
  expect((await account()).ibkrSyncTimeZone).toBeNull();
});
