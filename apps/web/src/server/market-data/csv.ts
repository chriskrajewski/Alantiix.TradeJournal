import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db, marketCsvDatasets, tradeExcursions } from "@/db";
import { RESOLUTIONS, type MarketBar, type Resolution } from "@/lib/market-data";
import { parseMarketCsv, type MarketCsvDataset } from "@/lib/market-csv";
import { MarketDataError, type MarketDataProvider } from "./provider";
import { result } from "./http";
// Immutable datasets; keep at most 200,000 decoded bars across files.
const decoded = new Map<string, MarketBar[]>();
let decodedCount = 0;
async function datasetBars(id: string) {
  const cached = decoded.get(id);
  if (cached) {
    decoded.delete(id);
    decoded.set(id, cached);
    return cached;
  }
  const row = await db
    .select({ json: marketCsvDatasets.barsJson })
    .from(marketCsvDatasets)
    .where(eq(marketCsvDatasets.id, id))
    .get();
  if (!row) throw new MarketDataError("CSV dataset was removed.");
  const bars = JSON.parse(row.json) as MarketBar[];
  decoded.set(id, bars);
  decodedCount += bars.length;
  while (decodedCount > 200_000) {
    const oldest = decoded.keys().next().value!;
    decodedCount -= decoded.get(oldest)!.length;
    decoded.delete(oldest);
  }
  return bars;
}
function lowerBound(bars: MarketBar[], time: number) {
  let lo = 0,
    hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (bars[mid]!.time < time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
export async function csvDatasets(): Promise<MarketCsvDataset[]> {
  return (
    await db
      .select({
        id: marketCsvDatasets.id,
        name: marketCsvDatasets.name,
        symbol: marketCsvDatasets.symbol,
        resolution: marketCsvDatasets.resolution,
        currency: marketCsvDatasets.currency,
        priceBasis: marketCsvDatasets.priceBasis,
        importedAt: marketCsvDatasets.importedAt,
        count: marketCsvDatasets.barCount,
        firstTime: marketCsvDatasets.firstTime,
        lastTime: marketCsvDatasets.lastTime,
      })
      .from(marketCsvDatasets)
      .all()
  ).map(({ firstTime, lastTime, ...row }) => ({
    ...row,
    resolution: row.resolution as Resolution,
    from: new Date(firstTime).toISOString(),
    to: new Date(lastTime + RESOLUTIONS[row.resolution as Resolution]).toISOString(),
  }));
}
export async function importCsvDataset(input: {
  name: string;
  symbol: string;
  resolution: Resolution;
  currency: string;
  priceBasis: string;
  content: string;
}) {
  const bars = parseMarketCsv(input.content, input.symbol, input.resolution);
  if ((await db.select({ id: marketCsvDatasets.id }).from(marketCsvDatasets).all()).length >= 50)
    throw new MarketDataError("Remove an unused dataset before adding more (50-file limit).");
  const { name, symbol, resolution, currency, priceBasis } = input;
  const metadata = { name, symbol, resolution, currency, priceBasis };
  const id = randomUUID();
  await db
    .insert(marketCsvDatasets)
    .values({
      ...metadata,
      id,
      importedAt: new Date().toISOString(),
      barsJson: JSON.stringify(bars),
      barCount: bars.length,
      firstTime: bars[0]!.time,
      lastTime: bars.at(-1)!.time,
    })
    .run();
  return id;
}
export async function removeCsvDataset(id: string) {
  await db.transaction(async (tx) => {
    await tx
      .delete(tradeExcursions)
      .where(sql`json_extract(${tradeExcursions.estimateJson}, '$.datasetId') = ${id}`)
      .run();
    await tx.delete(marketCsvDatasets).where(eq(marketCsvDatasets.id, id)).run();
  });
  const bars = decoded.get(id);
  if (bars) {
    decodedCount -= bars.length;
    decoded.delete(id);
  }
}
export const marketCsv: MarketDataProvider = {
  id: "market-csv",
  name: "Market data CSV",
  environmentKey: "",
  async test() {
    if (!(await csvDatasets()).length)
      throw new MarketDataError("Upload market candles in Settings first.");
  },
  async history(request) {
    const candidates = await db
      .select({
        id: marketCsvDatasets.id,
        name: marketCsvDatasets.name,
        priceBasis: marketCsvDatasets.priceBasis,
        currency: marketCsvDatasets.currency,
        firstTime: marketCsvDatasets.firstTime,
        lastTime: marketCsvDatasets.lastTime,
      })
      .from(marketCsvDatasets)
      .where(
        and(
          eq(marketCsvDatasets.symbol, request.symbol),
          eq(marketCsvDatasets.resolution, request.resolution),
          request.dataset ? eq(marketCsvDatasets.id, request.dataset) : undefined,
        ),
      )
      .all();
    const covering = candidates.filter(
      (row) =>
        row.firstTime <= request.from &&
        row.lastTime + RESOLUTIONS[request.resolution] >= request.to,
    );
    const choices = request.dataset ? candidates : covering.length ? covering : candidates;
    if (!choices.length)
      throw new MarketDataError(
        "No CSV dataset matches this symbol and resolution. Upload candles in Settings.",
      );
    if (choices.length > 1)
      throw new MarketDataError(
        "More than one CSV dataset matches. Select the dataset on this trade.",
      );
    const row = choices[0]!;
    const bars = await datasetBars(row.id);
    const start = lowerBound(bars, request.from - RESOLUTIONS[request.resolution] + 1);
    const end = lowerBound(bars, request.to);
    return {
      ...result(
        this.name,
        request,
        bars.slice(start, end),
        false,
        [
          `Local file: ${row.name}. Price basis: ${row.priceBasis}. Volume may be omitted; only supplied candles are used.`,
        ],
        row.currency,
      ),
      datasetId: row.id,
    };
  },
};
