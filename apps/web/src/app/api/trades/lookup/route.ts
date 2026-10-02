import { desc, eq } from "drizzle-orm";
import { accounts, db, trades } from "@/db";
import { handler, ok } from "@/server/api";
import type { LinkableTrade } from "@/lib/trade-links";

/** Stop after 51 matches; retain Unicode-aware searching without loading the entire history. */
export const GET = handler(async (request: Request) => {
  const search = new URL(request.url).searchParams.get("q")?.trim().toLowerCase() ?? "";
  const rows = await db
    .select({
      key: trades.key,
      symbol: trades.symbol,
      direction: trades.direction,
      openedAt: trades.openedAt,
      accountName: accounts.name,
    })
    .from(trades)
    .leftJoin(accounts, eq(trades.accountId, accounts.id))
    .orderBy(desc(trades.openedAt))
    .all();
  const matches: LinkableTrade[] = [];
  for (const row of rows) {
    const trade: LinkableTrade = {
      key: row.key,
      symbol: row.symbol,
      direction: row.direction as LinkableTrade["direction"],
      openedAt: row.openedAt,
      accountName: row.accountName ?? "Unknown account",
    };
    if (!`${trade.symbol} ${trade.openedAt} ${trade.accountName}`.toLowerCase().includes(search))
      continue;
    matches.push(trade);
    if (matches.length === 51) break;
  }
  return ok({ trades: matches.slice(0, 50), hasMore: matches.length > 50 });
});
