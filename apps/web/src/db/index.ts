import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import * as schema from "./schema";
import { BOOTSTRAP_SQL } from "./bootstrap";

export type JournalDb = LibSQLDatabase<typeof schema>;

const globalForDb = globalThis as unknown as {
  __journalClient?: Client;
  __journalDb?: JournalDb;
  __journalReady?: Promise<void>;
  __journalUrl?: string;
};

/** Local file path for libSQL `file:` URLs and legacy docs; not used on Vercel. */
export const dataDir = (): string => process.env.JOURNAL_DATA_DIR ?? join(process.cwd(), "data");

const resolveDatabaseUrl = (): string => {
  const configured = process.env.TURSO_DATABASE_URL?.trim();
  if (configured) return configured;
  // Local/dev fallback: libSQL file DB under the data directory (not durable on Vercel).
  if (process.env.VERCEL) {
    throw new Error(
      "TURSO_DATABASE_URL is required on Vercel. Create a Turso database and set TURSO_DATABASE_URL + TURSO_AUTH_TOKEN.",
    );
  }
  const filePath = join(dataDir(), "journal.db");
  return `file:${filePath}`;
};

const ensureLocalFileParent = (url: string): void => {
  if (!url.startsWith("file:") || url.startsWith("file::memory:")) return;
  const raw = url.slice("file:".length);
  const filePath = isAbsolute(raw) ? raw : join(process.cwd(), raw);
  mkdirSync(dirname(filePath), { recursive: true });
};

const tableHasColumn = async (client: Client, table: string, column: string): Promise<boolean> => {
  const result = await client.execute(`PRAGMA table_info(${table})`);
  return result.rows.some((row) => String(row.name) === column);
};

const applyAdditiveMigrations = async (client: Client): Promise<void> => {
  if (!(await tableHasColumn(client, "accounts", "ibkr_sync_time_zone"))) {
    await client.execute("ALTER TABLE accounts ADD COLUMN ibkr_sync_time_zone TEXT");
  }
  // Additive upgrade: existing executions retain their fields and dedup hashes.
  if (!(await tableHasColumn(client, "executions", "import_metadata_json"))) {
    await client.execute("ALTER TABLE executions ADD COLUMN import_metadata_json TEXT");
  }
  // Materialize CSV bounds once so connection and range lookups never scan candle JSON.
  for (const name of ["bar_count", "first_time", "last_time"] as const) {
    if (!(await tableHasColumn(client, "market_csv_datasets", name))) {
      await client.execute(
        `ALTER TABLE market_csv_datasets ADD COLUMN ${name} INTEGER NOT NULL DEFAULT 0`,
      );
    }
  }
  await client.execute(`UPDATE market_csv_datasets SET
    bar_count = json_array_length(bars_json),
    first_time = json_extract(bars_json, '$[0].time'),
    last_time = json_extract(bars_json, '$[#-1].time') WHERE bar_count = 0`);
};

const bootstrap = async (client: Client): Promise<void> => {
  await client.execute("PRAGMA foreign_keys = ON");
  await client.execute("PRAGMA busy_timeout = 5000");
  try {
    await client.execute("PRAGMA journal_mode = WAL");
  } catch {
    // Remote Turso may ignore or reject WAL; continue with bootstrap.
  }
  await client.executeMultiple(BOOTSTRAP_SQL);
  await applyAdditiveMigrations(client);
};

const createClientAndDb = (url: string): { client: Client; db: JournalDb } => {
  ensureLocalFileParent(url);
  const authToken = process.env.TURSO_AUTH_TOKEN?.trim();
  const client = createClient({
    url,
    ...(authToken ? { authToken } : {}),
  });
  const db = drizzle(client, { schema });
  return { client, db };
};

/** Recreate when TURSO_DATABASE_URL / JOURNAL_DATA_DIR changes (vitest scratch dirs). */
const ensureConnection = (): { client: Client; db: JournalDb } => {
  const url = resolveDatabaseUrl();
  if (globalForDb.__journalClient && globalForDb.__journalDb && globalForDb.__journalUrl === url) {
    return { client: globalForDb.__journalClient, db: globalForDb.__journalDb };
  }
  try {
    globalForDb.__journalClient?.close();
  } catch {
    // Previous file DB may already be gone after test teardown.
  }
  const created = createClientAndDb(url);
  globalForDb.__journalClient = created.client;
  globalForDb.__journalDb = created.db;
  globalForDb.__journalUrl = url;
  globalForDb.__journalReady = undefined;
  return created;
};

/**
 * Singleton Drizzle client (async libSQL / Turso).
 * Proxied so tests that change JOURNAL_DATA_DIR pick up a fresh file DB.
 * Await `ensureDb()` before first use.
 */
export const db: JournalDb = new Proxy({} as JournalDb, {
  get(_target, prop, receiver) {
    const real = ensureConnection().db as object;
    const value = Reflect.get(real, prop, receiver);
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(real) : value;
  },
});

/** Underlying libSQL client accessor (PRAGMA, raw SQL, test spies). */
export const getLibsql = (): Client => ensureConnection().client;

/** @deprecated Prefer getLibsql() when spying; proxy for convenient calls. */
export const libsql: Client = new Proxy({} as Client, {
  get(_target, prop, receiver) {
    const real = ensureConnection().client as object;
    const value = Reflect.get(real, prop, receiver);
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(real) : value;
  },
  has(_target, prop) {
    return prop in (ensureConnection().client as object);
  },
  ownKeys() {
    return Reflect.ownKeys(ensureConnection().client as object);
  },
  getOwnPropertyDescriptor(_target, prop) {
    return Reflect.getOwnPropertyDescriptor(ensureConnection().client as object, prop);
  },
});

/** Idempotent schema bootstrap; safe across Next hot reloads and serverless invocations. */
export const ensureDb = (): Promise<void> => {
  const { client } = ensureConnection();
  if (!globalForDb.__journalReady) {
    globalForDb.__journalReady = bootstrap(client).catch((error) => {
      globalForDb.__journalReady = undefined;
      throw error;
    });
  }
  return globalForDb.__journalReady;
};

export * from "./schema";
