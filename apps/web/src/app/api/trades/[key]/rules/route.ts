import { and, eq } from "drizzle-orm";
import { db, playbooks, tradeRuleChecks } from "@/db";
import { getTradeByKey } from "@/server/trades-query";
import { handler, ok, requireValue } from "@/server/api";
type Context = { params: Promise<{ key: string }> };
async function source(key: string) {
  const trade = await getTradeByKey(key);
  requireValue(trade, "Trade not found.");
  const book = trade.playbookId
    ? await db.select().from(playbooks).where(eq(playbooks.id, trade.playbookId)).get()
    : null;
  return { book, rules: book ? [...new Set(JSON.parse(book.rulesJson) as string[])] : [] };
}
export const GET = handler(async (_request: Request, { params }: Context) => {
  const key = (await params).key;
  const { book, rules } = await source(key);
  const checks = book
    ? await db
        .select()
        .from(tradeRuleChecks)
        .where(and(eq(tradeRuleChecks.tradeKey, key), eq(tradeRuleChecks.playbookId, book.id)))
        .all()
    : [];
  return ok({
    name: book?.name ?? null,
    rules: rules.map((rule) => ({
      rule,
      followed: checks.find((c) => c.rule === rule)?.followed ?? null,
    })),
  });
});
export const POST = handler(async (request: Request, { params }: Context) => {
  const key = (await params).key,
    b = await request.json();
  const { book, rules } = await source(key);
  requireValue(
    book && rules.includes(b.rule) && (b.followed === null || typeof b.followed === "boolean"),
    "Choose an existing strategy rule.",
  );
  const id = JSON.stringify([key, book.id, b.rule]);
  if (b.followed === null) await db.delete(tradeRuleChecks).where(eq(tradeRuleChecks.id, id)).run();
  else
    await db.insert(tradeRuleChecks)
      .values({ id, tradeKey: key, playbookId: book.id, rule: b.rule, followed: b.followed })
      .onConflictDoUpdate({ target: tradeRuleChecks.id, set: { followed: b.followed } })
      .run();
  return ok({ saved: true });
});
