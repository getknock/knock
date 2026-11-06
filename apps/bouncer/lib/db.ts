/**
 * The club's database (D32): libSQL, on Turso when the club runs on Vercel (TURSO_DATABASE_URL and
 * TURSO_AUTH_TOKEN), in a file here (file:human-club.db), in memory for tests. One schema holds the club's records
 * and what its verifier remembers.
 */
import { type Client, type Transaction, createClient } from '@libsql/client'

export type Db = Client
export type Tx = Transaction
/** A database or a transaction in it: anything that runs a statement */
export type Exec = Pick<Client, 'execute'>

const SCHEMA = `
CREATE TABLE IF NOT EXISTS humans (
  nullifier TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  first_at INTEGER NOT NULL,
  seen_at INTEGER NOT NULL,
  knocks INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS petitions (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  target TEXT NOT NULL,
  body TEXT NOT NULL,
  starter TEXT NOT NULL REFERENCES humans(nullifier),
  starter_name TEXT,
  day TEXT NOT NULL,
  at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'won', 'closed')),
  status_at INTEGER,
  UNIQUE (starter, day)
);
CREATE TABLE IF NOT EXISTS signatures (
  petition INTEGER NOT NULL REFERENCES petitions(id),
  nullifier TEXT NOT NULL REFERENCES humans(nullifier),
  name TEXT,
  reason TEXT,
  at INTEGER NOT NULL,
  counter INTEGER,
  binding_tx TEXT,
  binding_block INTEGER,
  PRIMARY KEY (petition, nullifier)
);
CREATE INDEX IF NOT EXISTS signatures_by_time ON signatures (petition, at);
CREATE INDEX IF NOT EXISTS signatures_by_human ON signatures (nullifier, at);
CREATE TABLE IF NOT EXISTS pending (
  challenge TEXT PRIMARY KEY,
  intent TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS fundraisers (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  story TEXT NOT NULL,
  goal TEXT NOT NULL,
  starter TEXT NOT NULL REFERENCES humans(nullifier),
  name TEXT NOT NULL,
  payout TEXT NOT NULL,
  day TEXT NOT NULL,
  at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  status_at INTEGER,
  UNIQUE (starter, day)
);
CREATE TABLE IF NOT EXISTS gifts (
  ref TEXT PRIMARY KEY,
  fundraiser INTEGER NOT NULL REFERENCES fundraisers(id),
  value TEXT NOT NULL,
  gwei INTEGER NOT NULL,
  human TEXT REFERENCES humans(nullifier),
  message TEXT,
  show_from INTEGER NOT NULL,
  asked_at INTEGER NOT NULL,
  tx TEXT UNIQUE,
  from_address TEXT,
  block INTEGER,
  given_at INTEGER
);
CREATE INDEX IF NOT EXISTS gifts_given ON gifts (fundraiser, given_at);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  nullifier TEXT NOT NULL REFERENCES humans(nullifier),
  at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS counters (
  key TEXT PRIMARY KEY,
  counter INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS revoked (
  key TEXT PRIMARY KEY,
  seen_at INTEGER NOT NULL
);
`

/** A database with the club's tables in it */
export async function open(url: string, authToken?: string): Promise<Db> {
  const db = createClient({ url, authToken })
  await db.executeMultiple(SCHEMA)
  return db
}

/** f in one write transaction: all of it, or none */
export async function inTx<T>(db: Db, f: (tx: Tx) => Promise<T>): Promise<T> {
  const tx = await db.transaction('write')
  try {
    const out = await f(tx)
    await tx.commit()
    return out
  } catch (e) {
    await tx.rollback().catch(() => {})
    throw e
  } finally {
    tx.close()
  }
}

type Arg = string | number | bigint | null

/** A statement's rows, as plain objects by column name */
export async function all<T>(db: Exec, sql: string, ...args: Arg[]): Promise<T[]> {
  const r = await db.execute({ sql, args })
  return r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])) as T)
}

/** A statement's first row, or null */
export async function one<T>(db: Exec, sql: string, ...args: Arg[]): Promise<T | null> {
  return (await all<T>(db, sql, ...args))[0] ?? null
}

export async function run(db: Exec, sql: string, ...args: Arg[]) {
  return db.execute({ sql, args })
}

export const unique = (e: unknown) => e instanceof Error && /UNIQUE constraint failed|PRIMARY KEY/.test(e.message)
