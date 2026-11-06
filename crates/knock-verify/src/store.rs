//! What a verifier remembers, in SQLite: the challenges it gave out, each Wedgie key's highest counter, the keys it
//! has seen revoked, and the entries for V8. Writes after a knock's checks happen in one transaction.

use std::sync::Mutex;

use alloy::primitives::B256;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};

use crate::{CHALLENGE_TTL, Refusal, no};

/// At most this many unexpired challenges at once.
const OUTSTANDING: i64 = 10_000;

pub struct Store {
    db: Mutex<Connection>,
}

fn trouble(e: rusqlite::Error) -> Refusal {
    no(0, "internal", format!("the verifier's store: {e}"))
}

impl Store {
    /// The store at `path` (":memory:" for one that lasts as long as the process).
    pub fn open(path: &str) -> rusqlite::Result<Self> {
        let db = Connection::open(path)?;
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS challenges (challenge BLOB PRIMARY KEY, origin TEXT NOT NULL,
                 issued_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
             CREATE TABLE IF NOT EXISTS counters (key BLOB PRIMARY KEY, counter INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS revoked (key BLOB PRIMARY KEY, seen_at INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS entries (action TEXT NOT NULL, nullifier BLOB NOT NULL, name TEXT NOT NULL,
                 at INTEGER NOT NULL, PRIMARY KEY (action, nullifier));",
        )?;
        Ok(Store { db: Mutex::new(db) })
    }

    fn db(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.db.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// A new challenge for `origin`. Expired ones go: a knock for one is refused all the same.
    pub fn issue(&self, origin: &str, now: u64) -> Result<B256, Refusal> {
        let db = self.db();
        let oldest = now.saturating_sub(CHALLENGE_TTL) as i64;
        db.execute("DELETE FROM challenges WHERE issued_at < ?1", [oldest])
            .map_err(trouble)?;
        let n: i64 = db
            .query_row("SELECT COUNT(*) FROM challenges", [], |r| r.get(0))
            .map_err(trouble)?;
        if n >= OUTSTANDING {
            return Err(no(
                2,
                "busy",
                "too many challenges out at once: try again in a minute",
            ));
        }
        let c = B256::from(rand::random::<[u8; 32]>());
        db.execute(
            "INSERT INTO challenges (challenge, origin, issued_at) VALUES (?1, ?2, ?3)",
            params![c.as_slice(), origin, now as i64],
        )
        .map_err(trouble)?;
        Ok(c)
    }

    /// V2: the challenge is one we gave out for our origin, unexpired and unused, and the knock is for our origin.
    pub fn fresh(&self, c: B256, ours: &str, knocked_for: &str, now: u64) -> Result<(), Refusal> {
        if knocked_for != ours {
            return Err(no(
                2,
                "wrong_origin",
                format!("the knock is for {knocked_for}, not {ours}"),
            ));
        }
        let row: Option<(String, i64, bool)> = self
            .db()
            .query_row(
                "SELECT origin, issued_at, used FROM challenges WHERE challenge = ?1",
                [c.as_slice()],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .map_err(trouble)?;
        match row {
            None => Err(no(
                2,
                "bad_challenge",
                "not a challenge this verifier gave out",
            )),
            Some((origin, _, _)) if origin != ours => {
                Err(no(2, "wrong_origin", "a challenge for another origin"))
            }
            Some((_, _, true)) => Err(no(2, "bad_challenge", "that challenge was used already")),
            Some((_, at, _)) if now.saturating_sub(at as u64) > CHALLENGE_TTL => Err(no(
                2,
                "bad_challenge",
                "that challenge expired: knock again",
            )),
            Some(_) => Ok(()),
        }
    }

    pub fn counter(&self, key: &[u8]) -> Result<Option<u64>, Refusal> {
        self.db()
            .query_row("SELECT counter FROM counters WHERE key = ?1", [key], |r| {
                r.get::<_, i64>(0)
            })
            .optional()
            .map(|c| c.map(|c| c as u64))
            .map_err(trouble)
    }

    pub fn revoke(&self, key: &[u8], now: u64) -> Result<(), Refusal> {
        self.db()
            .execute(
                "INSERT OR IGNORE INTO revoked (key, seen_at) VALUES (?1, ?2)",
                params![key, now as i64],
            )
            .map(drop)
            .map_err(trouble)
    }

    pub fn is_revoked(&self, key: &[u8]) -> Result<bool, Refusal> {
        self.db()
            .query_row("SELECT 1 FROM revoked WHERE key = ?1", [key], |_| Ok(()))
            .optional()
            .map(|r| r.is_some())
            .map_err(trouble)
    }

    pub fn entered(&self, action: &str, nullifier: B256) -> Result<bool, Refusal> {
        self.db()
            .query_row(
                "SELECT 1 FROM entries WHERE action = ?1 AND nullifier = ?2",
                params![action, nullifier.as_slice()],
                |_| Ok(()),
            )
            .optional()
            .map(|r| r.is_some())
            .map_err(trouble)
    }

    /// One transaction: the challenge used, the key's counter stored, the entry made; each checked again as it's
    /// written, so of two knocks racing for the same challenge, counter or entry, one gets it. A no writes nothing.
    pub fn commit(
        &self,
        c: B256,
        origin: &str,
        key: &[u8],
        counter: u64,
        entry: Option<(&str, B256, &str)>,
        now: u64,
    ) -> Result<(), Refusal> {
        let mut db = self.db();
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(trouble)?;
        let used = tx
            .execute(
                "UPDATE challenges SET used = 1 WHERE challenge = ?1 AND origin = ?2 AND used = 0 AND issued_at >= ?3",
                params![c.as_slice(), origin, now.saturating_sub(CHALLENGE_TTL) as i64],
            )
            .map_err(trouble)?;
        if used != 1 {
            return Err(no(
                2,
                "bad_challenge",
                "that challenge was used or expired meanwhile",
            ));
        }
        let rose = tx
            .execute(
                "INSERT INTO counters (key, counter) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE
                     SET counter = excluded.counter WHERE excluded.counter > counters.counter",
                params![key, counter as i64],
            )
            .map_err(trouble)?;
        if rose != 1 {
            return Err(no(
                5,
                "replayed",
                "the Wedgie's counter didn't rise: a knock seen before",
            ));
        }
        if let Some((action, nullifier, name)) = entry {
            let made = tx
                .execute(
                    "INSERT OR IGNORE INTO entries (action, nullifier, name, at) VALUES (?1, ?2, ?3, ?4)",
                    params![action, nullifier.as_slice(), name, now as i64],
                )
                .map_err(trouble)?;
            if made != 1 {
                return Err(no(
                    8,
                    "already_entered",
                    format!("this human has done {action} here already"),
                ));
            }
        }
        tx.commit().map_err(trouble)
    }

    #[cfg(test)]
    pub(crate) fn give(&self, c: B256, origin: &str, now: u64) {
        self.db()
            .execute(
                "INSERT INTO challenges (challenge, origin, issued_at) VALUES (?1, ?2, ?3)",
                params![c.as_slice(), origin, now as i64],
            )
            .unwrap();
    }
}
