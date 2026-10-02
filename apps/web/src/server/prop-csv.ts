import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { parseCsv } from "@luxalgo/journal-importers";
import { db, propEntries, propAudit, propReceipts } from "@/db";
import { mutateProp } from "./prop-firms";
import { requireValue, RequestError } from "./api";
import { newId, nowIso } from "./ids";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

type ImportResult = { imported: number; skipped: number; sample: Record<string, string>[] };

type PropSnapshot = {
  entries: Set<string>;
  receipts: Set<string>;
  audit: Set<string>;
};

const snapshotPropIds = async (): Promise<PropSnapshot> => ({
  entries: new Set((await db.select({ id: propEntries.id }).from(propEntries).all()).map((r) => r.id)),
  receipts: new Set(
    (await db.select({ id: propReceipts.id }).from(propReceipts).all()).map((r) => r.id),
  ),
  audit: new Set((await db.select({ id: propAudit.id }).from(propAudit).all()).map((r) => r.id)),
});

/** Undo rows created after `before` so CSV preview / failed imports stay atomic without nested tx. */
const restorePropSnapshot = async (before: PropSnapshot): Promise<void> => {
  const entryIds = (await db.select({ id: propEntries.id }).from(propEntries).all())
    .map((r) => r.id)
    .filter((id) => !before.entries.has(id));
  const receiptIds = (await db.select({ id: propReceipts.id }).from(propReceipts).all())
    .map((r) => r.id)
    .filter((id) => !before.receipts.has(id));
  const auditIds = (await db.select({ id: propAudit.id }).from(propAudit).all())
    .map((r) => r.id)
    .filter((id) => !before.audit.has(id));
  for (let i = 0; i < receiptIds.length; i += 500) {
    await db
      .delete(propReceipts)
      .where(inArray(propReceipts.id, receiptIds.slice(i, i + 500)))
      .run();
  }
  for (let i = 0; i < entryIds.length; i += 500) {
    await db
      .delete(propEntries)
      .where(inArray(propEntries.id, entryIds.slice(i, i + 500)))
      .run();
  }
  for (let i = 0; i < auditIds.length; i += 500) {
    await db
      .delete(propAudit)
      .where(inArray(propAudit.id, auditIds.slice(i, i + 500)))
      .run();
  }
};

/** Deliberately a generic settled-cash format; bank/firm CSVs need explicit mapping. */
export async function importPropCsv(content: string, preview: boolean): Promise<ImportResult> {
  requireValue(Buffer.byteLength(content) <= 2 * 1024 * 1024, "CSV must be 2 MB or smaller.");
  requireValue(
    (content.match(/"/g)?.length ?? 0) % 2 === 0,
    "CSV has an unterminated quoted field.",
  );
  const [header, ...rows] = parseCsv(content);
  const columns = [
    "id",
    "kind",
    "firm",
    "account_id",
    "currency",
    "date",
    "amount",
    "category",
    "expense_id",
    "reference",
    "notes",
  ];
  requireValue(
    header &&
      header.length === columns.length &&
      new Set(header).size === header.length &&
      columns.every((c) => header.includes(c)),
    "Use the generic prop cash CSV header template.",
  );
  requireValue(rows.length > 0 && rows.length <= 1000, "Import 1–1,000 rows at a time.");
  const records = rows.map((row, i) => {
    requireValue(
      row.length === header.length,
      `Row ${i + 2}: column count differs from the header.`,
    );
    return Object.fromEntries(columns.map((c) => [c, row[header.indexOf(c)]!.trim()]));
  });
  const seen = new Set<string>();
  for (const row of records) {
    requireValue(
      /^[a-zA-Z0-9_-]{1,100}$/.test(row.id!) && !seen.has(row.id!),
      "Each CSV row needs a unique stable ID.",
    );
    seen.add(row.id!);
  }

  const before = await snapshotPropIds();
  try {
    let imported = 0,
      skipped = 0;
    for (const [index, row] of records.entries()) {
      try {
        requireValue(
          ["expense", "refund", "payout"].includes(row.kind!),
          "Kind must be expense, refund or payout (actual cash received).",
        );
        const id = `csv-${hash(row.id!)}`,
          fingerprint = `CSV import ${hash(JSON.stringify(row))}`;
        const old = await db.select().from(propEntries).where(eq(propEntries.id, id)).get();
        if (old) {
          requireValue(
            await db
              .select({ id: propAudit.id })
              .from(propAudit)
              .where(and(eq(propAudit.entityId, id), eq(propAudit.reason, fingerprint)))
              .get(),
            "This CSV ID was already imported with different data. Edit the existing record or use a new ID for a separate transaction.",
          );
          skipped++;
          continue;
        }
        const command = {
          action: "entry.save",
          id,
          revision: 0,
          kind: row.kind,
          accountId: row.account_id,
          firm: row.firm,
          currency: row.currency,
          occurredOn: row.date,
          amount: row.amount,
          category: row.category,
          parentId: row.expense_id
            ? (await db
                .select({ id: propEntries.id })
                .from(propEntries)
                .where(eq(propEntries.id, row.expense_id))
                .get())
              ? row.expense_id
              : `csv-${hash(row.expense_id)}`
            : null,
          reference: row.reference,
          notes: row.notes,
          splitPercent: "100",
          fee: "0",
          status: "requested",
        };
        await mutateProp(command);
        if (row.kind === "payout") {
          await mutateProp({
            action: "receipt.add",
            id: `${id}-cash`,
            payoutId: id,
            revision: 1,
            kind: "receipt",
            amount: row.amount,
            occurredOn: row.date,
            reference: row.reference,
            notes: row.notes,
          });
          await mutateProp({
            ...command,
            revision: 2,
            status: "completed",
            reason: "Imported settled payout",
          });
        }
        await db
          .insert(propAudit)
          .values({
            id: newId(),
            entityType: "entry",
            entityId: id,
            beforeJson: null,
            afterJson: JSON.stringify(row),
            reason: fingerprint,
            createdAt: nowIso(),
          })
          .run();
        imported++;
      } catch (error) {
        throw new RequestError(`Row ${index + 2}: ${(error as Error).message}`);
      }
    }
    const result = { imported, skipped, sample: records.slice(0, 5) };
    if (preview) await restorePropSnapshot(before);
    return result;
  } catch (error) {
    await restorePropSnapshot(before);
    throw error;
  }
}
