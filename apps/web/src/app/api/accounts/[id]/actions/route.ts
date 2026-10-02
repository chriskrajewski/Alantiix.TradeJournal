import { eq } from "drizzle-orm";
import { accounts, db, executions, trades } from "@/db";
import { bad, handler, ok, requireValue } from "@/server/api";
import { nowIso } from "@/server/ids";
import { rebuildAccount } from "@/server/rebuild";
import { syncAccount } from "@/server/sync";
import { ibkrTransferTimeZone } from "@/server/ibkr-sync-timezone";

export const maxDuration = 60;

type Params = { params: Promise<{ id: string }> };

interface ActionBody {
  action: "archive" | "unarchive" | "clear" | "sync" | "transfer";
  /** For "transfer": destination account id. */
  toAccountId?: string;
}

export const POST = handler(async (request: Request, { params }: Params) => {
  const { id } = await params;
  const account = await db.select().from(accounts).where(eq(accounts.id, id)).get();
  if (!account) return bad("Account not found", 404);
  const body = (await request.json()) as ActionBody;

  switch (body.action) {
    case "archive":
      await db.update(accounts).set({ archivedAt: nowIso() }).where(eq(accounts.id, id)).run();
      return ok({ archived: true });
    case "unarchive":
      await db.update(accounts).set({ archivedAt: null }).where(eq(accounts.id, id)).run();
      return ok({ archived: false });
    case "clear":
      await db.transaction(async (tx) => {
        await tx.delete(trades).where(eq(trades.accountId, id)).run();
        await tx.delete(executions).where(eq(executions.accountId, id)).run();
        await tx.update(accounts).set({ ibkrSyncTimeZone: null }).where(eq(accounts.id, id)).run();
      });
      return ok({ cleared: true });
    case "sync":
      return ok({ sync: await syncAccount(id) });
    case "transfer": {
      if (!body.toAccountId) return bad("toAccountId is required");
      const destinationId = body.toAccountId;
      requireValue(destinationId !== id, "Choose a different destination account.");
      const destination = await db.select().from(accounts).where(eq(accounts.id, destinationId)).get();
      if (!destination) return bad("Destination account not found", 404);

      // Remember annotations before the move; trade keys are account-prefixed,
      // so after the rebuild they re-anchor under the destination's prefix.
      const sourceTrades = await db.select().from(trades).where(eq(trades.accountId, id)).all();
      await db.transaction(async (tx) => {
          const currentSource = await tx.select().from(accounts).where(eq(accounts.id, id)).get();
          const currentDestination = await tx
            .select()
            .from(accounts)
            .where(eq(accounts.id, destinationId))
            .get();
          requireValue(currentSource && currentDestination, "Account not found.");
          const timeZone = await ibkrTransferTimeZone(currentSource, currentDestination);
          if (timeZone !== undefined) {
            await tx.update(accounts)
              .set({ ibkrSyncTimeZone: timeZone })
              .where(eq(accounts.id, destinationId))
              .run();
          }
          await tx.update(executions)
            .set({ accountId: destinationId })
            .where(eq(executions.accountId, id))
            .run();
          await tx.delete(trades).where(eq(trades.accountId, id)).run();
          await tx.update(accounts).set({ ibkrSyncTimeZone: null }).where(eq(accounts.id, id)).run();
        },
        { behavior: "immediate" },
      );
      await rebuildAccount(destinationId);

      for (const source of sourceTrades) {
        const hasAnnotations =
          source.notes ||
          source.tagsJson ||
          source.mistakesJson ||
          source.playbookId ||
          source.rating !== null ||
          source.stopLoss !== null ||
          source.profitTarget !== null ||
          source.reviewedAt;
        if (!hasAnnotations) continue;
        const newKey = destinationId + source.key.slice(id.length);
        await db.update(trades)
          .set({
            notes: source.notes,
            tagsJson: source.tagsJson,
            mistakesJson: source.mistakesJson,
            playbookId: source.playbookId,
            rating: source.rating,
            stopLoss: source.stopLoss,
            profitTarget: source.profitTarget,
            reviewedAt: source.reviewedAt,
          })
          .where(eq(trades.key, newKey))
          .run();
      }
      return ok({ transferred: true });
    }
    default:
      return bad("Unknown action");
  }
});
