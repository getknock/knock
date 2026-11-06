//! POST /bind: one device bound to one human, on World Chain. The Console brings IDKit's result for `knock-bind`
//! and the device's `knock_bind_sig`. knockd checks the device's yes itself (its P-256 signature over KnockBind,
//! s low), has World ID's verifier check the human's in a simulation, and only then sends `KnockBinding.bind()`,
//! the gas key paying. A binding that would fail costs nothing.

use crate::{App, CHAIN_ID, Refusal, rp::hash_to_field, word};
use alloy::primitives::{Address, B256, Bytes, U256, keccak256};
use alloy::sol;
use alloy::sol_types::{SolError, SolStruct, eip712_domain};
use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use p256::ecdsa::{Signature, VerifyingKey, signature::hazmat::PrehashVerifier};
use serde::{Deserialize, Deserializer};
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::Duration;

sol! {
    #[sol(rpc)]
    #[allow(clippy::too_many_arguments)]
    contract KnockBinding {
        function RP_ID() external view returns (uint64);
        function WORLD_ID() external view returns (address);
        function bindDigest(uint256 nullifier, uint64 expiresAtMin, bytes32 x, bytes32 y) external view returns (bytes32);
        function bind(uint256 nullifier, uint256 nonce, uint64 expiresAtMin, uint64 issuerSchemaId,
            uint256 genesisIssuedAtMin, uint256[5] calldata proof, bytes32 x, bytes32 y, bytes32 r, bytes32 s) external;
        event Bound(uint256 indexed nullifier, bytes32 indexed keyHash, uint64 expiresAtMin);
        error NotSignedByDevice();
    }

    /// What the device signs to bind (Knock's EIP-712, domain {name: "Knock", version: "1"}).
    struct KnockBind { uint256 chainId; address registry; uint256 nullifier; uint64 expiresAtMin; bytes key; }

    // World ID's refusals, in the order its verifier checks (worldcoin/world-id-protocol).
    error InvalidMerkleRoot();
    error UnregisteredIssuerSchemaId();
    error ExpirationTooOld();
    error ProofInvalid();
    error PublicInputNotInField();
}

/// P-256's n / 2: a larger s is the other form of the same signature, which KnockBinding turns down.
const HALF_N: U256 = U256::from_be_bytes(alloy::primitives::hex!(
    "7FFFFFFF800000007FFFFFFFFFFFFFFFDE737D56D38BCF4279DCE5617E3192A8"
));

/// KnockBinding.bindDigest, worked out here: what the device signed for this binding.
pub fn bind_digest(registry: Address, nullifier: U256, expires_at_min: u64, key: &[u8]) -> B256 {
    let m = KnockBind {
        chainId: U256::from(CHAIN_ID),
        registry,
        nullifier,
        expiresAtMin: expires_at_min,
        key: Bytes::copy_from_slice(key),
    };
    m.eip712_signing_hash(&eip712_domain! { name: "Knock", version: "1", })
}

/// The device's key from its 33-byte compressed form (the device's `key`, the World ID signal): (x, y).
pub fn device_key(key: &[u8]) -> Option<(VerifyingKey, B256, B256)> {
    if key.len() != 33 {
        return None;
    }
    let vk = VerifyingKey::from_sec1_bytes(key).ok()?;
    let point = vk.to_sec1_point(false);
    Some((
        vk,
        B256::from_slice(point.x()?),
        B256::from_slice(point.y()?),
    ))
}

/// The device's yes: (r, s) over the digest under its key, s low.
pub fn signed_by(vk: &VerifyingKey, digest: B256, r: B256, s: B256) -> bool {
    if U256::from_be_bytes(s.0) > HALF_N {
        return false;
    }
    let Ok(sig) = Signature::from_scalars(r.0, s.0) else {
        return false;
    };
    vk.verify_prehash(digest.as_slice(), &sig).is_ok()
}

/// A number as JSON has it: a number, or a string of decimal or 0x-hex digits (IDKit's nullifiers and proofs).
pub struct Num(U256);

impl<'de> Deserialize<'de> for Num {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Raw {
            N(u64),
            S(String),
        }
        match Raw::deserialize(d)? {
            Raw::N(n) => Ok(Num(U256::from(n))),
            Raw::S(s) => s
                .parse::<U256>()
                .map(Num)
                .map_err(|_| serde::de::Error::custom("not a uint256")),
        }
    }
}

/// IDKit's result for `knock-bind` (one response), and the device's `knock_bind_sig`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BindRequest {
    /// The result's environment: staging (Simulator proofs) or production (World App).
    environment: String,
    nullifier: Num,
    /// The request's nonce: the RP context's, which the result repeats.
    nonce: Num,
    expires_at_min: Num,
    issuer_schema_id: Num,
    /// The request's minimum credential genesis; 0 (the default) when it had none.
    #[serde(default)]
    genesis_issued_at_min: Option<Num>,
    proof: [Num; 5],
    /// The result's signal_hash, checked against the key when given.
    #[serde(default)]
    signal_hash: Option<Num>,
    /// The device's knock_bind_sig: its compressed key and (r, s).
    key: String,
    r: String,
    s: String,
}

fn u64_of(n: &Num, what: &str) -> Result<u64, Refusal> {
    u64::try_from(n.0).map_err(|_| Refusal::bad(format!("{what}: a uint64")))
}

fn bytes_of(s: &str, len: usize, what: &str) -> Result<Vec<u8>, Refusal> {
    alloy::primitives::hex::decode(s)
        .ok()
        .filter(|b| b.len() == len)
        .ok_or_else(|| Refusal::bad(format!("{what}: 0x and {} hex digits", 2 * len)))
}

/// A revert's name, when it's one we know: World ID's verifier, or KnockBinding's own.
fn refusal_name(data: &[u8]) -> Option<&'static str> {
    let sel: [u8; 4] = data.get(..4)?.try_into().ok()?;
    [
        (InvalidMerkleRoot::SELECTOR, "InvalidMerkleRoot"),
        (
            UnregisteredIssuerSchemaId::SELECTOR,
            "UnregisteredIssuerSchemaId",
        ),
        (ExpirationTooOld::SELECTOR, "ExpirationTooOld"),
        (ProofInvalid::SELECTOR, "ProofInvalid"),
        (PublicInputNotInField::SELECTOR, "PublicInputNotInField"),
        (
            KnockBinding::NotSignedByDevice::SELECTOR,
            "NotSignedByDevice",
        ),
    ]
    .into_iter()
    .find(|(s, _)| *s == sel)
    .map(|(_, n)| n)
}

/// What the person can do about a refusal, when there's something: a proof World ID no longer takes, or doesn't
/// take yet, needs a new one.
fn next_step(name: &str) -> Option<&'static str> {
    match name {
        "InvalidMerkleRoot" => Some(
            "World ID doesn't accept the Merkle root this proof was made against, not yet or no longer. \
             Bind again for a new proof",
        ),
        "ExpirationTooOld" => {
            Some("The proof is more than 5 hours old. Bind again for a new proof")
        }
        _ => None,
    }
}

fn chain_trouble(app: &App, what: &str, e: impl std::fmt::Display) -> Refusal {
    tracing::warn!("bind: {what}: {}", app.redact(e));
    Refusal::new(
        StatusCode::BAD_GATEWAY,
        "chain",
        format!("World Chain: {what} failed; try again"),
    )
}

pub async fn bind(
    State(app): State<Arc<App>>,
    Json(q): Json<BindRequest>,
) -> Result<Json<Value>, Refusal> {
    let env = app.env(&q.environment)?;
    let nullifier = q.nullifier.0;
    let nonce = q.nonce.0;
    let expires = u64_of(&q.expires_at_min, "expiresAtMin")?;
    let issuer = u64_of(&q.issuer_schema_id, "issuerSchemaId")?;
    let genesis = q.genesis_issued_at_min.as_ref().map_or(U256::ZERO, |n| n.0);
    let proof = q.proof.each_ref().map(|n| n.0);
    let key = bytes_of(&q.key, 33, "key")?;
    let (vk, x, y) = device_key(&key).ok_or_else(|| Refusal::bad("key: a compressed P-256 key"))?;
    let r = B256::from_slice(&bytes_of(&q.r, 32, "r")?);
    let s = B256::from_slice(&bytes_of(&q.s, 32, "s")?);
    if let Some(h) = &q.signal_hash
        && h.0 != U256::from_be_bytes(hash_to_field(&key).0)
    {
        return Err(Refusal::bad(
            "signalHash: the proof's signal isn't this device's key",
        ));
    }
    if !signed_by(
        &vk,
        bind_digest(env.binding, nullifier, expires, &key),
        r,
        s,
    ) {
        return Err(Refusal::new(
            StatusCode::FORBIDDEN,
            "not_signed",
            format!(
                "the device didn't sign this binding (KnockBind for {}'s KnockBinding, s low)",
                env.name
            ),
        ));
    }

    app.simulations.take()?;
    let _one = app.sending.lock().await;
    let kb = KnockBinding::new(env.binding, &app.chain);
    let call = kb
        .bind(
            nullifier, nonce, expires, issuer, genesis, proof, x, y, r, s,
        )
        .from(app.gas);
    if let Err(e) = call.call().await {
        return Err(match e.as_revert_data() {
            Some(data) => {
                let name =
                    refusal_name(&data).map_or_else(|| format!("revert {data}"), str::to_string);
                tracing::info!("bind: {} refuses ({name}); nothing sent", env.name);
                let step = next_step(&name).map_or_else(String::new, |s| format!(". {s}"));
                Refusal::new(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "refused",
                    format!("{} says no: {name}{step}", env.name),
                )
            }
            None => chain_trouble(&app, "the simulation", e),
        });
    }
    app.sends.take()?;
    let pending = call
        .send()
        .await
        .map_err(|e| chain_trouble(&app, "sending", e))?;
    let receipt = pending
        .with_timeout(Some(Duration::from_secs(90)))
        .get_receipt()
        .await
        .map_err(|e| chain_trouble(&app, "waiting for the receipt", e))?;
    let tx = receipt.transaction_hash;
    if !receipt.status() {
        tracing::warn!("bind: {} tx {tx} reverted", env.name);
        return Err(Refusal::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "reverted",
            format!("tx {tx} reverted"),
        ));
    }
    let bound = receipt
        .inner
        .logs()
        .iter()
        .filter(|l| l.address() == env.binding)
        .find_map(|l| l.log_decode::<KnockBinding::Bound>().ok())
        .ok_or_else(|| chain_trouble(&app, "reading Bound", format!("no Bound log in {tx}")))?
        .inner
        .data;
    tracing::info!(
        "bind: {} bound, tx {tx}, gas {}",
        env.name,
        receipt.gas_used
    );
    Ok(Json(json!({
        "environment": env.name,
        "chainId": CHAIN_ID,
        "contract": env.binding,
        "tx": tx,
        "block": receipt.block_number,
        "gasUsed": receipt.gas_used,
        "poh": format!("eip155:{CHAIN_ID}:tx:{tx}"),
        "bound": {
            "nullifier": word(bound.nullifier),
            "keyHash": bound.keyHash,
            "expiresAtMin": bound.expiresAtMin,
        },
        "keyHash": keccak256([x.as_slice(), y.as_slice()].concat()),
    })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy::primitives::hex;

    const VECTORS: &str = include_str!("../../../spec/vectors/v1.json");

    fn v() -> Value {
        serde_json::from_str(VECTORS).unwrap()
    }

    fn b(s: &Value) -> Vec<u8> {
        hex::decode(s.as_str().unwrap()).unwrap()
    }

    fn the_binding() -> (Vec<u8>, Address, U256, u64, B256, B256, B256) {
        let v = v();
        let m = &v["structs"]["KnockBind"]["message"];
        assert_eq!(m["chainId"], CHAIN_ID);
        let expires =
            u64::try_from(m["expiresAtMin"].as_str().unwrap().parse::<U256>().unwrap()).unwrap();
        (
            b(&m["key"]),
            m["registry"].as_str().unwrap().parse().unwrap(),
            m["nullifier"].as_str().unwrap().parse().unwrap(),
            expires,
            B256::from_slice(&b(&v["structs"]["KnockBind"]["digest"])),
            B256::from_slice(&b(&v["structs"]["KnockBind"]["r"])),
            B256::from_slice(&b(&v["structs"]["KnockBind"]["s"])),
        )
    }

    #[test]
    fn the_vectors_digest() {
        let (key, registry, nullifier, expires, digest, ..) = the_binding();
        assert_eq!(bind_digest(registry, nullifier, expires, &key), digest);
    }

    #[test]
    fn the_vectors_key_signal_and_key_hash() {
        let v = v();
        let (_, x, y) = device_key(&b(&v["key"]["compressed"])).unwrap();
        assert_eq!(
            (x.to_vec(), y.to_vec()),
            (b(&v["key"]["x"]), b(&v["key"]["y"]))
        );
        assert_eq!(
            keccak256([x.as_slice(), y.as_slice()].concat()).to_vec(),
            b(&v["key"]["keyHash"])
        );
        assert_eq!(
            hash_to_field(&b(&v["key"]["compressed"])).to_vec(),
            b(&v["key"]["signalHash"])
        );
    }

    #[test]
    fn the_vectors_signature_and_its_refusals() {
        let (key, registry, nullifier, expires, digest, r, s) = the_binding();
        let (vk, ..) = device_key(&key).unwrap();
        assert!(signed_by(&vk, digest, r, s));
        let n = U256::from_be_bytes(hex!(
            "FFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551"
        ));
        let high = B256::from(n - U256::from_be_bytes(s.0));
        assert!(!signed_by(&vk, digest, r, high), "the high-s twin");
        assert!(
            !signed_by(
                &vk,
                bind_digest(registry, nullifier + U256::from(1), expires, &key),
                r,
                s
            ),
            "another human"
        );
        assert!(
            !signed_by(
                &vk,
                bind_digest(registry, nullifier, expires + 1, &key),
                r,
                s
            ),
            "another expiry"
        );
        assert!(
            !signed_by(
                &vk,
                bind_digest(Address::ZERO, nullifier, expires, &key),
                r,
                s
            ),
            "another contract"
        );
        let mut other = key.clone();
        other[0] ^= 1; // 02 <-> 03: the other key with this x
        let (vk2, ..) = device_key(&other).unwrap();
        assert!(
            !signed_by(
                &vk2,
                bind_digest(registry, nullifier, expires, &other),
                r,
                s
            ),
            "the other key with this x"
        );
        assert!(
            device_key(&key[..32]).is_none() && device_key(&[4u8; 33]).is_none(),
            "not a key"
        );
    }

    #[test]
    fn numbers_as_idkit_writes_them() {
        let n: Num = serde_json::from_str("\"0x00f0\"").unwrap();
        assert_eq!(n.0, U256::from(0xf0));
        let n: Num = serde_json::from_str("\"1756166400\"").unwrap();
        assert_eq!(n.0, U256::from(1756166400u64));
        let n: Num = serde_json::from_str("1756166400").unwrap();
        assert_eq!(n.0, U256::from(1756166400u64));
        assert!(
            serde_json::from_str::<Num>("\"0xzz\"").is_err()
                && serde_json::from_str::<Num>("-1").is_err()
        );
    }

    #[test]
    fn world_ids_refusals_by_name() {
        assert_eq!(
            refusal_name(&InvalidMerkleRoot::SELECTOR),
            Some("InvalidMerkleRoot")
        );
        assert_eq!(
            refusal_name(&KnockBinding::NotSignedByDevice::SELECTOR),
            Some("NotSignedByDevice")
        );
        assert_eq!(refusal_name(&[0, 0, 0, 0]), None);
        assert!(
            next_step("InvalidMerkleRoot")
                .is_some_and(|s| s.ends_with("Bind again for a new proof"))
        );
        assert!(
            next_step("ExpirationTooOld")
                .is_some_and(|s| s.ends_with("Bind again for a new proof"))
        );
        assert_eq!(next_step("ProofInvalid"), None);
    }
}
