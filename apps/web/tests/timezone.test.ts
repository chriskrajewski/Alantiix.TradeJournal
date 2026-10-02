import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dayKeyOf } from "@luxalgo/journal-core";
import { formatTimestamp, isTimeZone } from "../src/lib/timezone";

const scratch = mkdtempSync(join(tmpdir(), "journal-timezone-"));
vi.stubEnv("JOURNAL_DATA_DIR", scratch);
vi.stubEnv("JOURNAL_PASSWORD", "");
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
const { db, accounts, executions, trades, settings, ensureDb } = await import("../src/db");
const { setSetting, getTimeZone, getImportTimeZone } = await import("../src/server/settings");
const { POST: importFile } = await import("../src/app/api/import/route");
const { GET: getSettings, PATCH: patchSettings } = await import("../src/app/api/settings/route");
const { GET: stats } = await import("../src/app/api/stats/route");
const { GET: journal } = await import("../src/app/api/journal/route");
const { GET: calendar } = await import("../src/app/api/calendar/route");
const { GET: listTrades } = await import("../src/app/api/trades/route");
const { GET: tradeDetail } = await import("../src/app/api/trades/[key]/route");
const { GET: exportData } = await import("../src/app/api/export/route");
const html = readFileSync(
  new URL("../../../docs/samples/mt5-timezone.html", import.meta.url),
  "utf8",
);
const request = (path: string, body?: unknown) =>
  new Request(
    `http://localhost/api/${path}`,
    body === undefined ? undefined : { method: "POST", body: JSON.stringify(body) },
  );
const save = (body: unknown) => patchSettings(request("settings", body));
const post = async (body: object) => {
  const response = await importFile(request("import", body));
  const result = await response.json();
  expect(response.status, JSON.stringify(result)).toBe(200);
  return result;
};

beforeEach(async () => {
  await ensureDb();
  await db.delete(trades).run();
  await db.delete(executions).run();
  await db.delete(settings).run();
  await db.delete(accounts).run();
  await db.insert(accounts)
    .values({ id: "test", name: "Timezone test", kind: "import", createdAt: "2026-01-01" })
    .run();
});
afterEach(async () => vi.useRealTimers());
afterAll(async () => {
  vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
});

describe("statement and display timezones are independent", () => {
  it("preserves legacy import behavior when only the display timezone changes", async () => {
    expect(await getImportTimeZone()).toBe("UTC");
    await setSetting("timeZone", "Europe/Helsinki");
    expect(await getImportTimeZone()).toBe("Europe/Helsinki");
    expect((await save({ timeZone: "America/Argentina/Buenos_Aires" })).status).toBe(200);
    expect(await getImportTimeZone()).toBe("Europe/Helsinki");
    expect(await getTimeZone()).toBe("America/Argentina/Buenos_Aires");
    await save({ timeZone: "America/New_York" });
    expect(await getImportTimeZone()).toBe("Europe/Helsinki");
  });

  it.each([
    ["2026.01.05", "2026-01-05T02:00:00.000Z"],
    ["2026.07.05", "2026-07-05T01:00:00.000Z"],
  ])(
    "imports broker wall-clock time correctly in %s and deduplicates the same file",
    async (date, expected) => {
      await save({ timeZone: "America/Argentina/Buenos_Aires", importTimeZone: "Europe/Helsinki" });
      const content = html.replaceAll("2026.07.05", date);
      const preview = await post({ mode: "preview", content });
      expect(preview).toMatchObject({
        detected: "history-metatrader",
        timeZone: "Europe/Helsinki",
      });
      expect(preview.executions[0].executedAt).toBe(expected);
      expect(await db.select().from(executions).all()).toHaveLength(0);
      await post({ mode: "commit", accountId: "test", content });
      expect(
        (await db
          .select()
          .from(executions)
          .all())
          .map((row) => row.executedAt),
      ).toContain(expected);
      expect(await post({ mode: "commit", accountId: "test", content })).toMatchObject({
        inserted: 0,
        duplicates: 2,
      });
    },
  );

  it("uses a per-file override in both preview and commit without changing defaults", async () => {
    await save({ timeZone: "America/Argentina/Buenos_Aires", importTimeZone: "UTC" });
    const preview = await post({ mode: "preview", content: html, timeZone: "Europe/Helsinki" });
    // The UI sends the preview's zone even if the saved default changes before commit.
    await save({ importTimeZone: "America/New_York" });
    await post({ mode: "commit", accountId: "test", content: html, timeZone: preview.timeZone });
    expect(
      (await db
        .select()
        .from(executions)
        .all())
        .map((row) => row.executedAt),
    ).toContain("2026-07-05T01:00:00.000Z");
    expect(await getImportTimeZone()).toBe("America/New_York");
    expect(await getTimeZone()).toBe("America/Argentina/Buenos_Aires");
  });

  it("applies the statement timezone to column-mapped CSV files too", async () => {
    await save({ timeZone: "America/Argentina/Buenos_Aires", importTimeZone: "Europe/Helsinki" });
    const body = {
      content: "Ticker,Action,Units,Cost,When\nEURUSD,buy,1,1.1,2026-07-05 04:00",
      mapping: {
        symbol: "Ticker",
        side: "Action",
        quantity: "Units",
        price: "Cost",
        timestamp: "When",
      },
    };
    const preview = await post({ ...body, mode: "preview" });
    expect(preview.executions[0].executedAt).toBe("2026-07-05T01:00:00.000Z");
    await post({ ...body, mode: "commit", accountId: "test" });
    expect((await db.select().from(executions).get())?.executedAt).toBe("2026-07-05T01:00:00.000Z");
  });

  it("honors explicit UTC offsets regardless of the statement timezone", async () => {
    await save({ importTimeZone: "America/Argentina/Buenos_Aires" });
    const content = html
      .replaceAll("2026.07.05 04:00", "2026-07-05T04:00:00+03:00")
      .replaceAll("2026.07.05 04:30", "2026-07-05T04:30:00+03:00");
    const preview = await post({ mode: "preview", content });
    expect(preview.executions[0].executedAt).toBe("2026-07-05T01:00:00.000Z");
  });

  it.each(["Mars/Olympus", "", null, 42, {}])(
    "rejects invalid zone %j before any setting or execution write",
    async (invalid) => {
      await setSetting("timeZone", "Europe/Helsinki");
      expect((await save({ timeZone: "America/Argentina/Buenos_Aires", importTimeZone: invalid })).status).toBe(
        400,
      );
      expect((await save({ timeZone: invalid, importTimeZone: "UTC" })).status).toBe(400);
      expect(await getTimeZone()).toBe("Europe/Helsinki");
      expect(await getImportTimeZone()).toBe("Europe/Helsinki");
      for (const mode of ["preview", "commit"])
        expect(
          (
            await importFile(
              request("import", { mode, accountId: "test", content: html, timeZone: invalid }),
            )
          ).status,
        ).toBe(400);
      expect(await db.select().from(executions).all()).toHaveLength(0);
    },
  );

  it("aligns trade dates, execution times, analytics and journal/calendar days across midnight", async () => {
    await save({ timeZone: "America/Argentina/Buenos_Aires", importTimeZone: "Europe/Helsinki" });
    await post({ mode: "commit", accountId: "test", content: html });
    const stored = (await db.select().from(trades).get())!;
    const dashboard = await (await stats(request("stats?calYear=2026&calMonth=7"))).json();
    expect(dashboard.days[0].date).toBe("2026-07-04");
    expect(dashboard.buckets.hour.find((bucket: { trades: number }) => bucket.trades > 0).key).toBe(
      "22",
    );
    const days = await (await journal(request("journal"))).json();
    expect(days.days[0].date).toBe("2026-07-04");
    const month = await (await calendar(request("calendar?calYear=2026&calMonth=7"))).json();
    expect(
      month.calendar.weeks
        .flatMap((week: { days: Array<{ date: string; trades: number } | null> }) => week.days)
        .filter((day: { trades: number } | null) => day?.trades),
    ).toMatchObject([{ date: "2026-07-04" }]);
    const detail = await (
      await tradeDetail(request("trades/test"), { params: Promise.resolve({ key: stored.key }) })
    ).json();
    const listed = await (await listTrades(request("trades?view=list"))).json();
    expect(
      detail.executions
        .map((fill: { executedAt: string }) => formatTimestamp(fill.executedAt, detail.timeZone))
        .sort(),
    ).toEqual(["2026-07-04 22:00:00", "2026-07-04 22:30:00"]);
    expect(dayKeyOf(listed.trades[0].closedAt, listed.timeZone)).toBe("2026-07-04");
    expect(dayKeyOf(dashboard.recentTrades[0].closedAt, dashboard.timeZone)).toBe("2026-07-04");
    await save({ timeZone: "Europe/Helsinki", importTimeZone: "UTC" });
    expect((await db.select().from(trades).get())?.closedAt).toBe(stored.closedAt);
    expect((await (await journal(request("journal"))).json()).days[0].date).toBe("2026-07-05");
  });

  it("uses the journal's current month at the UTC month boundary", async () => {
    await save({ timeZone: "America/Argentina/Buenos_Aires" });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-01T01:00:00Z"));
    const result = await (await stats(request("stats"))).json();
    expect(result.calendar).toMatchObject({ year: 2026, month: 7 });
  });

  it("returns and backs up both timezone settings", async () => {
    await save({ timeZone: "America/Argentina/Buenos_Aires", importTimeZone: "Europe/Helsinki" });
    expect(await (await getSettings()).json()).toMatchObject({
      timeZone: "America/Argentina/Buenos_Aires",
      importTimeZone: "Europe/Helsinki",
    });
    expect((await (await exportData(request("export"))).json()).settings).toMatchObject({
      timeZone: "America/Argentina/Buenos_Aires",
      importTimeZone: "Europe/Helsinki",
    });
  });
});

describe("display formatting", () => {
  it("handles DST offsets, midnight and fractional-hour zones without the device timezone", async () => {
    expect(formatTimestamp("2026-01-05T07:00:00Z", "Europe/Helsinki")).toBe("2026-01-05 09:00:00");
    expect(formatTimestamp("2026-07-05T06:00:00Z", "Europe/Helsinki")).toBe("2026-07-05 09:00:00");
    expect(formatTimestamp("2026-07-05T03:00:00Z", "America/Argentina/Buenos_Aires")).toBe("2026-07-05 00:00:00");
    expect(formatTimestamp("2026-07-05T00:00:00Z", "Asia/Kathmandu")).toBe("2026-07-05 05:45:00");
    expect(isTimeZone("Europe/Helsinki")).toBe(true);
    expect(isTimeZone(undefined)).toBe(false);
  });
});
