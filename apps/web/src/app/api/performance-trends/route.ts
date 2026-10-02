import { readFilters } from "@luxalgo/journal-core";
import { accounts, db } from "@/db";
import { performanceTrends } from "@/lib/performance-trends";
import { handler, ok } from "@/server/api";
import { getTimeZone } from "@/server/settings";
import { queryTrades } from "@/server/trades-query";

export const GET = handler(async (request: Request) => {
  const { trades } = await queryTrades(readFilters(new URL(request.url).searchParams));
  const currencies = new Map(
    (await db
      .select({ id: accounts.id, currency: accounts.currency })
      .from(accounts)
      .all()).map((account) => [account.id, account.currency]),
  );
  return ok({
    trends: performanceTrends(trades),
    currencies: [
      ...new Set(
        trades
          .filter((trade) => trade.status !== "open" && trade.closedAt)
          .map((trade) => currencies.get(trade.accountId) ?? "USD"),
      ),
    ],
    timeZone: await getTimeZone(),
  });
});
