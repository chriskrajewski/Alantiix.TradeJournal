import {
  db,
  accounts,
  executions,
  journalDays,
  notes,
  playbooks,
  trades,
  attachments,
  noteTemplates,
  tradeRuleChecks,
  progressRules,
  progressChecks,
  missedTrades,
  folders,
  propAccounts,
  propEntries,
  propReceipts,
  propAudit,
  importSources,
  importSourceAliases,
  importBatches,
} from "@/db";
import { readFilters } from "@luxalgo/journal-core";
import { queryTrades } from "@/server/trades-query";
import {
  getJournalDefaults,
  getMultipliers,
  getTimeZone,
  getImportTimeZone,
} from "@/server/settings";
import { handler, ok } from "@/server/api";
import { attachmentExportRecord, EXPORT_ATTACHMENTS_NOTE } from "@/lib/export-format";

export const maxDuration = 60;

/**
 * Full data export: your journal is yours. Credentials are deliberately
 * excluded: an export must be safe to share or move between machines.
 */
export const GET = handler(async (request: Request) => {
  const url = new URL(request.url);
  const format = url.searchParams.get("format") ?? "json";

  if (format === "csv") {
    const header =
      "key,account_id,symbol,direction,status,opened_at,closed_at,quantity,avg_entry,avg_exit,gross_pnl,fees,net_pnl,tags,notes";
    const escape = (value: unknown): string => {
      const text = value === null || value === undefined ? "" : String(value);
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const lines = (await queryTrades(readFilters(url.searchParams))).rows.map((row) =>
      [
        row.key,
        row.accountId,
        row.symbol,
        row.direction,
        row.status,
        row.openedAt,
        row.closedAt ?? "",
        row.quantity,
        row.avgEntry,
        row.avgExit ?? "",
        row.grossPnl,
        row.fees,
        row.netPnl,
        row.tagsJson ?? "[]",
        row.notes ?? "",
      ]
        .map(escape)
        .join(","),
    );
    return new Response([header, ...lines].join("\n"), {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": 'attachment; filename="trades.csv"',
      },
    });
  }

  return ok({
    exportedAt: new Date().toISOString(),
    note: EXPORT_ATTACHMENTS_NOTE,
    accounts: (await db
      .select()
      .from(accounts)
      .all()).map(({ credentialsEnc: _omitted, ...safe }) => safe),
    executions: await db.select().from(executions).all(),
    importSources: await db.select().from(importSources).all(),
    importSourceAliases: await db.select().from(importSourceAliases).all(),
    importBatches: await db.select().from(importBatches).all(),
    trades: await db.select().from(trades).all(),
    journalDays: await db.select().from(journalDays).all(),
    notes: await db.select().from(notes).all(),
    folders: await db.select().from(folders).all(),
    playbooks: await db.select().from(playbooks).all(),
    noteTemplates: await db.select().from(noteTemplates).all(),
    tradeRuleChecks: await db.select().from(tradeRuleChecks).all(),
    progressRules: await db.select().from(progressRules).all(),
    progressChecks: await db.select().from(progressChecks).all(),
    missedTrades: await db.select().from(missedTrades).all(),
    propAccounts: await db.select().from(propAccounts).all(),
    propEntries: await db.select().from(propEntries).all(),
    propReceipts: await db.select().from(propReceipts).all(),
    propAudit: await db.select().from(propAudit).all(),
    journalDefaults: await getJournalDefaults(),
    settings: {
      timeZone: await getTimeZone(),
      importTimeZone: await getImportTimeZone(),
      multipliers: await getMultipliers(),
    },
    // Metadata only: attachment binaries stay in the data directory.
    attachments: (
      await db
        .select({
          id: attachments.id,
          ownerType: attachments.ownerType,
          ownerId: attachments.ownerId,
          name: attachments.name,
          mime: attachments.mime,
          size: attachments.size,
          createdAt: attachments.createdAt,
        })
        .from(attachments)
        .all()
    ).map(attachmentExportRecord),
  });
});
