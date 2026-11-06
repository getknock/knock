//! knock-verify: a site's check of a knock (PLAN §3), V1–V8 in order, failing closed.
//!
//! A knock is the KnockPass a Wedgie signed after a green press, for the site's challenge and origin. Nothing in it
//! is taken on trust: the name's records come from ENS on mainnet, the human from the `Bound` log that `knock.poh`
//! names on World Chain, and the press from the signature under the key ENS holds. What a knock uses up (its
//! challenge, its counter, an entry) is written in one SQLite transaction once every check has passed, so a
//! refused knock uses up nothing.

mod store;

use std::collections::HashMap;
use std::future::Future;
use std::sync::Mutex;

use alloy::ens::namehash;
use alloy::primitives::{Address, B256, U256, keccak256};
use alloy::sol;
use alloy::sol_types::{SolEvent, SolStruct, eip712_domain};
use p256::ecdsa::{Signature, VerifyingKey, signature::hazmat::PrehashVerifier};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub use store::Store;

/// World Chain, where bindings live.
pub const WORLD_CHAIN: u64 = 480;
/// How long a challenge lasts, in seconds (V2).
pub const CHALLENGE_TTL: u64 = 120;
/// How many blocks deep `knock.status=active` has to be on mainnet (V3).
pub const DEPTH: u64 = 3;
/// How long a name's deep records are kept, in seconds (V3). Revocation is read from the latest block every time.
pub const CACHE_TTL: u64 = 60;
/// The records V3 reads, in [`Records`]' order.
pub const RECORDS: [&str; 5] = [
    "knock.v",
    "knock.key",
    "knock.status",
    "knock.nullifier",
    "knock.poh",
];

const HALF_N: U256 = U256::from_be_bytes(alloy::primitives::hex!(
    "7FFFFFFF800000007FFFFFFFFFFFFFFFDE737D56D38BCF4279DCE5617E3192A8"
));
const DEPLOYMENTS: &str = include_str!("../../../contracts/deployments/480.json");

sol! {
    /// What a Wedgie signs for a knock (EIP-712, domain Knock v1).
    struct KnockPass {
        bytes32 challenge;
        string origin;
        bytes32 deviceNode;
        uint64 counter;
        uint8 mode;
        uint256 nullifier;
        bytes32 humanRef;
    }

    /// KnockBinding's record: this key is one human's, for this name (D22). v3's first and later bindings alike.
    event Bound(uint256 indexed nullifier, bytes32 indexed keyHash, bytes32 indexed node, uint64 expiresAtMin);
}

/// The KnockBinding whose `Bound` logs count: v3, production (D22, D24). Staging's takes Simulator proofs, a v1
/// binding names no name, and v2's are retired with it, so none of those counts.
pub fn accepted_binding() -> Result<Address, String> {
    let d: Value = serde_json::from_str(DEPLOYMENTS).map_err(|e| e.to_string())?;
    if d["chainId"] != WORLD_CHAIN || d["production"]["version"] != 3 {
        return Err("deployments: no KnockBinding v3 on World Chain".into());
    }
    d["production"]["KnockBinding"]
        .as_str()
        .and_then(|a| a.parse::<Address>().ok())
        .filter(|a| !a.is_zero())
        .ok_or_else(|| "deployments: no production KnockBinding".into())
}

/// A no, with the check that said it (1–8; 0 for the verifier's own trouble) and a code a site can act on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    pub check: u8,
    pub error: &'static str,
    pub why: String,
}

fn no(check: u8, error: &'static str, why: impl Into<String>) -> Refusal {
    Refusal {
        check,
        error,
        why: why.into(),
    }
}

/// The chain couldn't be read: nothing about the knock is known, so it isn't taken.
#[derive(Debug, Clone)]
pub struct Unavailable(pub String);

impl Unavailable {
    fn at(self, check: u8) -> Refusal {
        no(
            check,
            "unavailable",
            format!("couldn't read the chain, try again: {}", self.0),
        )
    }
}

/// A knock as the Door hands it to the site (door-sdk's `Assertion`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Assertion {
    pub v: u8,
    pub name: String,
    pub challenge: B256,
    pub origin: String,
    pub device_node: B256,
    pub counter: u64,
    pub mode: u8,
    pub nullifier: B256,
    pub human_ref: B256,
    pub r: B256,
    pub s: B256,
}

/// A name Knock takes: a-z, 0-9 and "-", with dots between (the Console's rule, which ENS leaves as it is).
pub fn ok_name(name: &str) -> bool {
    let labels: Vec<&str> = name.split('.').collect();
    name.len() <= 255
        && labels.len() >= 2
        && labels.iter().all(|l| {
            !l.is_empty()
                && l.len() <= 63
                && l.bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
                && l.get(2..4) != Some("--")
        })
}

/// An origin as a browser writes one, and as the Wedgie takes it: https://host[:port], or http://localhost or
/// 127.0.0.1 for development.
pub fn ok_origin(o: &str) -> bool {
    let (rest, local) = match (o.strip_prefix("https://"), o.strip_prefix("http://")) {
        (Some(r), _) => (r, false),
        (_, Some(r)) => (r, true),
        _ => return false,
    };
    let (host, port) = match rest.split_once(':') {
        Some((h, p)) => (h, Some(p)),
        None => (rest, None),
    };
    (!local || host == "localhost" || host == "127.0.0.1")
        && !host.is_empty()
        && host
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'.' || c == b'-')
        && port.is_none_or(|p| (1..=5).contains(&p.len()) && p.bytes().all(|c| c.is_ascii_digit()))
}

/// V1: a knock, whole and well formed, its s low.
pub fn parse(v: &Value) -> Result<Assertion, Refusal> {
    let bad = |why: String| no(1, "bad_assertion", why);
    let a: Assertion =
        serde_json::from_value(v.clone()).map_err(|e| bad(format!("not a knock: {e}")))?;
    if a.v != 1 {
        return Err(bad(format!("version {}: this verifier reads 1", a.v)));
    }
    if !ok_name(&a.name) {
        return Err(bad("name: a-z, 0-9 and \"-\", with dots between".into()));
    }
    if a.device_node != namehash(&a.name) {
        return Err(bad("deviceNode isn't the name's namehash".into()));
    }
    if !ok_origin(&a.origin) {
        return Err(bad(
            "origin: https://host[:port], or http://localhost".into()
        ));
    }
    if a.counter == 0 || a.counter > i64::MAX as u64 {
        return Err(bad("counter: from 1 up".into()));
    }
    if a.mode != 1 && a.mode != 2 {
        return Err(bad("mode: 1 (Bound) or 2 (Fresh)".into()));
    }
    if a.r.is_zero() || a.s.is_zero() || U256::from_be_bytes(a.s.0) > HALF_N {
        return Err(bad("signature: r and s, s low".into()));
    }
    Ok(a)
}

/// KnockPass's EIP-712 digest, as the Wedgie computes it.
pub fn pass_digest(
    challenge: B256,
    origin: &str,
    node: B256,
    counter: u64,
    mode: u8,
    nullifier: U256,
    human_ref: B256,
) -> B256 {
    KnockPass {
        challenge,
        origin: origin.into(),
        deviceNode: node,
        counter,
        mode,
        nullifier,
        humanRef: human_ref,
    }
    .eip712_signing_hash(&eip712_domain! { name: "Knock", version: "1", })
}

/// The Wedgie's yes: (r, s) over the digest under its key, s low.
pub fn signed_by(vk: &VerifyingKey, digest: B256, r: B256, s: B256) -> bool {
    if U256::from_be_bytes(s.0) > HALF_N {
        return false;
    }
    let Ok(sig) = Signature::from_scalars(r.0, s.0) else {
        return false;
    };
    vk.verify_prehash(digest.as_slice(), &sig).is_ok()
}

/// A name's Knock records at one block, as ENS gives them (`None`: empty or missing).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Records {
    pub v: Option<String>,
    pub key: Option<String>,
    pub status: Option<String>,
    pub nullifier: Option<String>,
    pub poh: Option<String>,
}

impl Records {
    /// From the texts of [`RECORDS`], in order.
    pub fn from_texts([v, key, status, nullifier, poh]: [Option<String>; 5]) -> Self {
        Records {
            v,
            key,
            status,
            nullifier,
            poh,
        }
    }

    fn says(&self, status: &str) -> bool {
        self.status.as_deref() == Some(status)
    }
}

/// What V3 takes from the records: the Wedgie's key, the human, and the transaction of their binding.
#[derive(Debug, Clone)]
pub struct Valid {
    pub key: [u8; 33],
    pub vk: VerifyingKey,
    /// keccak256(x ‖ y), as `Bound` names the key.
    pub key_hash: B256,
    pub nullifier: U256,
    pub poh: B256,
}

/// `knock.key`: a 33-byte compressed P-256 key, 0x and 66 hex digits.
pub fn parse_key(s: &str) -> Option<([u8; 33], VerifyingKey, B256)> {
    let hex = s.strip_prefix("0x")?;
    if hex.len() != 66 || !hex.bytes().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let bytes: [u8; 33] = alloy::primitives::hex::decode(hex).ok()?.try_into().ok()?;
    let vk = VerifyingKey::from_sec1_bytes(&bytes).ok()?;
    let point = vk.to_sec1_point(false);
    let xy = [point.x()?.as_slice(), point.y()?.as_slice()].concat();
    Some((bytes, vk, keccak256(xy)))
}

fn parse_word(s: &str) -> Option<U256> {
    let hex = s.strip_prefix("0x")?;
    (hex.len() == 64 && hex.bytes().all(|c| c.is_ascii_hexdigit()))
        .then(|| U256::from_str_radix(hex, 16).ok())?
}

/// `knock.poh`: eip155:480:tx:<hash>.
fn parse_poh(s: &str) -> Option<B256> {
    let hex = s.strip_prefix("eip155:480:tx:0x")?;
    (hex.len() == 64 && hex.bytes().all(|c| c.is_ascii_hexdigit()))
        .then(|| format!("0x{hex}").parse().ok())?
}

/// V3: the name holds Knock's records, `status=active` seen at least [`DEPTH`] blocks deep (`deep`), and nothing
/// different at the latest block (`latest`), where a revoke counts at once. An expired name doesn't resolve: ENSv2's
/// registries give an expired name no resolver, so its records read as empty.
pub fn check_records(name: &str, deep: &Records, latest: &Records) -> Result<Valid, Refusal> {
    if *latest == Records::default() {
        return Err(no(
            3,
            "no_name",
            format!("{name} has no Knock records in ENS: never named, or killed"),
        ));
    }
    if latest.says("revoked") {
        return Err(no(
            3,
            "revoked",
            format!("{name} is revoked: its owner turned it off"),
        ));
    }
    if latest.v.as_deref() != Some("1") {
        return Err(no(
            3,
            "not_knock",
            format!("{name} isn't a Knock name (knock.v isn't 1)"),
        ));
    }
    if deep != latest {
        return Err(no(
            3,
            "records_changing",
            format!("{name}'s Knock records changed in the last few blocks: try again in a minute"),
        ));
    }
    if !deep.says("active") {
        return Err(no(
            3,
            "not_active",
            format!("{name}'s knock.status isn't active"),
        ));
    }
    let bad = |what: &str| no(3, "bad_records", format!("{name}'s {what}"));
    let (key, vk, key_hash) = deep
        .key
        .as_deref()
        .and_then(parse_key)
        .ok_or_else(|| bad("knock.key isn't a compressed P-256 key"))?;
    let nullifier = deep
        .nullifier
        .as_deref()
        .and_then(parse_word)
        .ok_or_else(|| bad("knock.nullifier isn't a word"))?;
    let poh = deep
        .poh
        .as_deref()
        .and_then(parse_poh)
        .ok_or_else(|| bad("knock.poh isn't eip155:480:tx:<hash>"))?;
    Ok(Valid {
        key,
        vk,
        key_hash,
        nullifier,
        poh,
    })
}

/// A World Chain receipt, as much of it as V6 reads.
#[derive(Debug, Clone)]
pub struct Receipt {
    pub ok: bool,
    pub block: u64,
    pub logs: Vec<Log>,
}

#[derive(Debug, Clone)]
pub struct Log {
    pub address: Address,
    pub topics: Vec<B256>,
    pub data: Vec<u8>,
}

/// The binding a knock stands on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    pub tx: B256,
    pub block: u64,
    /// The proof's `expiresAtMin`: about when it was made (unix seconds).
    pub proved_at: u64,
}

/// What V6 asks of a binding.
pub struct Wanted {
    pub tx: B256,
    pub contract: Address,
    pub nullifier: U256,
    pub key_hash: B256,
    pub node: B256,
    /// The highest World Chain block counted as final.
    pub final_block: u64,
    pub now: u64,
    pub max_age: u64,
}

/// V6, the binding: the transaction `knock.poh` names succeeded on the accepted KnockBinding, with a `Bound` for this
/// key, this human and this name, final, and its proof no older than `max_age` (D23).
pub fn check_binding(r: Option<&Receipt>, w: &Wanted) -> Result<Binding, Refusal> {
    let tx = w.tx;
    let r = r.ok_or_else(|| {
        no(
            6,
            "no_binding",
            format!("World Chain has no transaction {tx}"),
        )
    })?;
    if !r.ok {
        return Err(no(
            6,
            "no_binding",
            format!("the binding's transaction {tx} failed"),
        ));
    }
    let topics = [
        Bound::SIGNATURE_HASH,
        B256::from(w.nullifier),
        w.key_hash,
        w.node,
    ];
    let proved_at = r
        .logs
        .iter()
        .find(|l| l.address == w.contract && l.topics == topics && l.data.len() == 32 && l.data[..24] == [0; 24])
        .map(|l| u64::from_be_bytes(l.data[24..].try_into().unwrap()))
        .ok_or_else(|| {
            no(
                6,
                "no_binding",
                format!("transaction {tx} holds no Bound from Knock's KnockBinding for this key, human and name"),
            )
        })?;
    if r.block > w.final_block {
        return Err(no(
            6,
            "binding_not_final",
            "the binding isn't final on World Chain yet: try again in a few minutes",
        ));
    }
    if w.now.saturating_sub(proved_at) > w.max_age {
        return Err(no(
            6,
            "binding_expired",
            format!(
                "the binding is more than {} days old: bind the Wedgie again",
                w.max_age / 86_400
            ),
        ));
    }
    Ok(Binding {
        tx,
        block: r.block,
        proved_at,
    })
}

/// Where the verifier reads the chains: mainnet for ENS, World Chain for bindings.
pub trait Chain: Sync {
    /// Mainnet's latest block.
    fn head(&self) -> impl Future<Output = Result<u64, Unavailable>> + Send;
    /// A name's [`RECORDS`] at a mainnet block, through the Universal Resolver.
    fn records(
        &self,
        name: &str,
        block: u64,
    ) -> impl Future<Output = Result<Records, Unavailable>> + Send;
    /// A World Chain transaction's receipt, if there is one.
    fn receipt(
        &self,
        tx: B256,
    ) -> impl Future<Output = Result<Option<Receipt>, Unavailable>> + Send;
    /// The highest World Chain block counted as final (its safe or finalized head).
    fn final_block(&self) -> impl Future<Output = Result<u64, Unavailable>> + Send;
}

/// A challenge for the site's page, to hand to the Door.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Challenge {
    pub challenge: B256,
    pub origin: String,
    pub expires_at: u64,
}

/// A knock that passed: the name, the Wedgie's key, the human (their nullifier for Knock's action) and the binding.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Knocked {
    pub name: String,
    pub key: String,
    pub nullifier: B256,
    pub counter: u64,
    pub origin: String,
    pub binding: Binding,
}

/// A site's verifier, for one origin.
pub struct Verifier<C> {
    pub chain: C,
    pub store: Store,
    pub origin: String,
    pub contract: Address,
    pub max_binding_age: u64,
    cache: Mutex<HashMap<String, (u64, Records)>>,
}

impl<C: Chain> Verifier<C> {
    pub fn new(
        chain: C,
        store: Store,
        origin: String,
        contract: Address,
        max_binding_age: u64,
    ) -> Self {
        Verifier {
            chain,
            store,
            origin,
            contract,
            max_binding_age,
            cache: Mutex::new(HashMap::new()),
        }
    }

    pub fn challenge(&self, now: u64) -> Result<Challenge, Refusal> {
        Ok(Challenge {
            challenge: self.store.issue(&self.origin, now)?,
            origin: self.origin.clone(),
            expires_at: now + CHALLENGE_TTL,
        })
    }

    /// The name's records [`DEPTH`] blocks deep. A deep read that was active and the same as the latest block's is
    /// kept up to [`CACHE_TTL`], and used while the latest block still shows the same: any change reads it again.
    async fn deep(
        &self,
        name: &str,
        head: u64,
        latest: &Records,
        now: u64,
    ) -> Result<Records, Refusal> {
        let hit = {
            let cache = self.cache.lock().unwrap();
            cache
                .get(name)
                .filter(|(at, r)| now.saturating_sub(*at) <= CACHE_TTL && r == latest)
                .map(|(_, r)| r.clone())
        };
        if let Some(r) = hit {
            return Ok(r);
        }
        let r = self
            .chain
            .records(name, head.saturating_sub(DEPTH))
            .await
            .map_err(|e| e.at(3))?;
        let mut cache = self.cache.lock().unwrap();
        if cache.len() > 1024 {
            cache.clear();
        }
        if r.says("active") && r == *latest {
            cache.insert(name.to_string(), (now, r.clone()));
        } else {
            cache.remove(name);
        }
        Ok(r)
    }

    /// V1–V8 in order, then the commit. `action` is the site's action for V8 (one entry per human), if it has one.
    pub async fn verify(
        &self,
        assertion: &Value,
        action: Option<&str>,
        now: u64,
    ) -> Result<Knocked, Refusal> {
        // V1
        let a = parse(assertion)?;
        // V2
        self.store
            .fresh(a.challenge, &self.origin, &a.origin, now)?;
        // V3
        let head = self.chain.head().await.map_err(|e| e.at(3))?;
        let latest = self
            .chain
            .records(&a.name, head)
            .await
            .map_err(|e| e.at(3))?;
        let deep = self.deep(&a.name, head, &latest, now).await?;
        for r in [&latest, &deep] {
            if let (true, Some((key, _, _))) =
                (r.says("revoked"), r.key.as_deref().and_then(parse_key))
            {
                self.store.revoke(&key, now)?; // a key seen revoked is invalid forever
            }
        }
        let valid = check_records(&a.name, &deep, &latest)?;
        if self.store.is_revoked(&valid.key)? {
            return Err(no(
                3,
                "revoked",
                "this Wedgie's key was seen revoked, and stays revoked",
            ));
        }
        // V4: the digest from our own challenge and origin, the name's node and the knock's fields
        let node = namehash(&a.name);
        let nullifier = U256::from_be_bytes(a.nullifier.0);
        let digest = pass_digest(
            a.challenge,
            &self.origin,
            node,
            a.counter,
            a.mode,
            nullifier,
            a.human_ref,
        );
        if !signed_by(&valid.vk, digest, a.r, a.s) {
            return Err(no(
                4,
                "bad_signature",
                format!(
                    "not signed by {}'s key, for this site and challenge",
                    a.name
                ),
            ));
        }
        // V5
        if self
            .store
            .counter(&valid.key)?
            .is_some_and(|c| a.counter <= c)
        {
            return Err(no(
                5,
                "replayed",
                "the Wedgie's counter didn't rise: a knock seen before",
            ));
        }
        // V6, Bound
        if a.mode == 2 {
            return Err(no(
                7,
                "mode_unsupported",
                "Fresh (mode 2) isn't offered yet",
            )); // V7
        }
        if !a.human_ref.is_zero() {
            return Err(no(6, "bad_assertion", "humanRef: zero in mode 1"));
        }
        if nullifier != valid.nullifier {
            return Err(no(
                6,
                "wrong_human",
                format!("the knock's human isn't {}'s", a.name),
            ));
        }
        let receipt = self.chain.receipt(valid.poh).await.map_err(|e| e.at(6))?;
        let final_block = self.chain.final_block().await.map_err(|e| e.at(6))?;
        let binding = check_binding(
            receipt.as_ref(),
            &Wanted {
                tx: valid.poh,
                contract: self.contract,
                nullifier,
                key_hash: valid.key_hash,
                node,
                final_block,
                now,
                max_age: self.max_binding_age,
            },
        )?;
        // V8
        if let Some(action) = action
            && self.store.entered(action, a.nullifier)?
        {
            return Err(no(
                8,
                "already_entered",
                format!("this human has done {action} here already"),
            ));
        }
        // All of it, or none
        self.store.commit(
            a.challenge,
            &self.origin,
            &valid.key,
            a.counter,
            action.map(|x| (x, a.nullifier, a.name.as_str())),
            now,
        )?;
        Ok(Knocked {
            name: a.name,
            key: format!("0x{}", alloy::primitives::hex::encode(valid.key)),
            nullifier: a.nullifier,
            counter: a.counter,
            origin: a.origin,
            binding,
        })
    }
}

#[cfg(test)]
mod tests;
