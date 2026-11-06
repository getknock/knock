// The verifier against a stand-in chain and an in-memory store, with the protocol's vectors: the TypeScript side's
// signed KnockPass verifies here as it is, and each check refuses what it should, using nothing up when it does.
use std::sync::Mutex;

use alloy::primitives::{Address, B256, U256, hex};
use alloy::sol_types::SolEvent;
use p256::ecdsa::{Signature, SigningKey, signature::hazmat::PrehashSigner};
use serde_json::{Value, json};

use super::*;

const V: &str = include_str!("../../../spec/vectors/v1.json");
const NOW: u64 = 1_794_979_500;
const HEAD: u64 = 23_900_000;
const TX: &str = "0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd";

fn vectors() -> Value {
    serde_json::from_str(V).unwrap()
}
fn s(v: &Value) -> String {
    v.as_str().unwrap().to_string()
}
fn pass() -> Value {
    vectors()["structs"]["KnockPass"].clone()
}
fn origin() -> String {
    s(&pass()["message"]["origin"])
}
fn name() -> String {
    s(&vectors()["device"]["name"])
}
fn challenge() -> B256 {
    s(&pass()["message"]["challenge"]).parse().unwrap()
}
fn nullifier() -> B256 {
    s(&pass()["message"]["nullifier"]).parse().unwrap()
}

fn records() -> Records {
    Records {
        v: Some("1".into()),
        key: Some(s(&vectors()["key"]["compressed"])),
        status: Some("active".into()),
        nullifier: Some(s(&pass()["message"]["nullifier"])),
        poh: Some(format!("eip155:480:tx:{TX}")),
    }
}

/// The `Bound` KnockBinding v2 emits for the vectors' key and human, for `node`, proved an hour before NOW.
fn bound(contract: Address, node: B256) -> Log {
    Log {
        address: contract,
        topics: vec![
            Bound::SIGNATURE_HASH,
            nullifier(),
            s(&vectors()["key"]["keyHash"]).parse().unwrap(),
            node,
        ],
        data: U256::from(NOW - 3600).to_be_bytes::<32>().to_vec(),
    }
}

fn receipt() -> Receipt {
    Receipt {
        ok: true,
        block: 37_300_000,
        logs: vec![bound(accepted_binding().unwrap(), namehash(&name()))],
    }
}

struct Fake {
    latest: Mutex<Records>,
    deep: Mutex<Records>,
    receipt: Mutex<Option<Receipt>>,
    final_block: Mutex<u64>,
    down: Mutex<bool>,
    reads: Mutex<Vec<u64>>,
}

impl Chain for Fake {
    async fn head(&self) -> Result<u64, Unavailable> {
        if *self.down.lock().unwrap() {
            Err(Unavailable("down".into()))
        } else {
            Ok(HEAD)
        }
    }
    async fn records(&self, _: &str, block: u64) -> Result<Records, Unavailable> {
        self.reads.lock().unwrap().push(block);
        Ok(if block == HEAD {
            self.latest.lock().unwrap().clone()
        } else {
            self.deep.lock().unwrap().clone()
        })
    }
    async fn receipt(&self, tx: B256) -> Result<Option<Receipt>, Unavailable> {
        assert_eq!(
            tx,
            TX.parse::<B256>().unwrap(),
            "the receipt read is knock.poh's"
        );
        Ok(self.receipt.lock().unwrap().clone())
    }
    async fn final_block(&self) -> Result<u64, Unavailable> {
        Ok(*self.final_block.lock().unwrap())
    }
}

fn verifier() -> Verifier<Fake> {
    let chain = Fake {
        latest: Mutex::new(records()),
        deep: Mutex::new(records()),
        receipt: Mutex::new(Some(receipt())),
        final_block: Mutex::new(37_300_100),
        down: Mutex::new(false),
        reads: Mutex::new(vec![]),
    };
    let v = Verifier::new(
        chain,
        Store::open(":memory:").unwrap(),
        origin(),
        accepted_binding().unwrap(),
        365 * 86_400,
    );
    v.store.give(challenge(), &origin(), NOW - 10);
    v
}

/// The vectors' knock, as the Door hands it over: signed by the TypeScript side.
fn the_vectors_knock() -> Value {
    let m = &pass()["message"];
    json!({
        "v": 1, "name": name(), "challenge": m["challenge"], "origin": m["origin"], "deviceNode": m["deviceNode"],
        "counter": m["counter"], "mode": m["mode"], "nullifier": m["nullifier"], "humanRef": m["humanRef"],
        "r": pass()["r"], "s": pass()["s"],
    })
}

/// A knock signed now with the vectors' key: for `challenge`, signed for `origin`, with `counter` and `mode`.
fn knock(challenge: B256, origin: &str, counter: u64, mode: u8) -> Value {
    let key =
        SigningKey::from_slice(&hex::decode(s(&vectors()["key"]["secret"])).unwrap()).unwrap();
    let d = pass_digest(
        challenge,
        origin,
        namehash(&name()),
        counter,
        mode,
        U256::from_be_bytes(nullifier().0),
        B256::ZERO,
    );
    let sig: Signature = key.sign_prehash(d.as_slice()).unwrap();
    let sig = sig.normalize_s();
    let mut k = the_vectors_knock();
    k["challenge"] = json!(challenge);
    k["origin"] = json!(origin);
    k["counter"] = json!(counter);
    k["mode"] = json!(mode);
    k["r"] = json!(B256::from_slice(&sig.r().to_bytes()));
    k["s"] = json!(B256::from_slice(&sig.s().to_bytes()));
    k
}

fn refused(r: Result<Knocked, Refusal>) -> (u8, &'static str) {
    let e = r.expect_err("a knock that should be refused was taken");
    (e.check, e.error)
}

#[test]
fn the_digest_and_key_are_the_vectors() {
    let m = pass()["message"].clone();
    let d = pass_digest(
        challenge(),
        &origin(),
        s(&m["deviceNode"]).parse().unwrap(),
        42,
        1,
        U256::from_be_bytes(nullifier().0),
        B256::ZERO,
    );
    assert_eq!(d, s(&pass()["digest"]).parse::<B256>().unwrap());
    let (_, vk, key_hash) = parse_key(&s(&vectors()["key"]["compressed"])).unwrap();
    assert_eq!(
        key_hash,
        s(&vectors()["key"]["keyHash"]).parse::<B256>().unwrap()
    );
    assert!(signed_by(
        &vk,
        d,
        s(&pass()["r"]).parse().unwrap(),
        s(&pass()["s"]).parse().unwrap()
    ));
    assert_eq!(
        namehash(&name()),
        s(&vectors()["device"]["node"]).parse::<B256>().unwrap()
    );
}

#[test]
fn the_accepted_binding_is_v2_production() {
    assert_eq!(
        accepted_binding().unwrap(),
        "0x001173856e4148538c46A0B572664C0Fde99B62c"
            .parse::<Address>()
            .unwrap()
    );
}

#[tokio::test]
async fn the_vectors_knock_is_taken_once() {
    let v = verifier();
    let k = v.verify(&the_vectors_knock(), None, NOW).await.unwrap();
    assert_eq!(
        (k.name.as_str(), k.counter, k.origin.as_str()),
        (name().as_str(), 42, origin().as_str())
    );
    assert_eq!(k.key, s(&vectors()["key"]["compressed"]));
    assert_eq!(
        k.binding,
        Binding {
            tx: TX.parse().unwrap(),
            block: 37_300_000,
            proved_at: NOW - 3600
        }
    );
    assert_eq!(
        *v.chain.reads.lock().unwrap(),
        vec![HEAD, HEAD - DEPTH],
        "the latest block, then 3 deep"
    );
    assert_eq!(
        refused(v.verify(&the_vectors_knock(), None, NOW).await),
        (2, "bad_challenge")
    );
}

#[tokio::test]
async fn the_counter_has_to_rise() {
    let v = verifier();
    v.verify(&the_vectors_knock(), None, NOW).await.unwrap();
    let c2 = B256::repeat_byte(7);
    v.store.give(c2, &origin(), NOW);
    assert_eq!(
        refused(v.verify(&knock(c2, &origin(), 42, 1), None, NOW).await),
        (5, "replayed")
    );
    assert_eq!(
        refused(v.verify(&knock(c2, &origin(), 41, 1), None, NOW).await),
        (5, "replayed")
    );
    v.verify(&knock(c2, &origin(), 43, 1), None, NOW)
        .await
        .unwrap();
}

#[tokio::test]
async fn a_revoke_counts_from_the_latest_block_and_for_ever() {
    let v = verifier();
    v.chain.latest.lock().unwrap().status = Some("revoked".into());
    assert_eq!(
        refused(v.verify(&the_vectors_knock(), None, NOW).await),
        (3, "revoked")
    );
    // Active again, even deep: the key stays revoked
    *v.chain.latest.lock().unwrap() = records();
    assert_eq!(
        refused(v.verify(&the_vectors_knock(), None, NOW + 1).await),
        (3, "revoked")
    );
}

#[tokio::test]
async fn a_killed_name_a_new_one_and_changing_records() {
    let v = verifier();
    *v.chain.latest.lock().unwrap() = Records::default();
    assert_eq!(
        refused(v.verify(&the_vectors_knock(), None, NOW).await),
        (3, "no_name")
    );
    // Named in the last 3 blocks: not deep enough yet
    *v.chain.latest.lock().unwrap() = records();
    *v.chain.deep.lock().unwrap() = Records::default();
    assert_eq!(
        refused(v.verify(&the_vectors_knock(), None, NOW).await),
        (3, "records_changing")
    );
    *v.chain.deep.lock().unwrap() = Records {
        poh: Some(format!("eip155:480:tx:0x{}", "ab".repeat(32))),
        ..records()
    };
    assert_eq!(
        refused(v.verify(&the_vectors_knock(), None, NOW).await),
        (3, "records_changing")
    );
    *v.chain.deep.lock().unwrap() = records();
    v.verify(&the_vectors_knock(), None, NOW).await.unwrap();
}

#[tokio::test]
async fn records_that_arent_knocks() {
    for (change, code) in [
        (
            Records {
                v: Some("2".into()),
                ..records()
            },
            "not_knock",
        ),
        (
            Records {
                status: Some("paused".into()),
                ..records()
            },
            "not_active",
        ),
        (
            Records {
                key: Some(format!("0x05{}", "11".repeat(32))),
                ..records()
            },
            "bad_records",
        ),
        (
            Records {
                key: Some(format!("0x02{}", "ff".repeat(32))),
                ..records()
            },
            "bad_records",
        ),
        (
            Records {
                key: Some(s(&vectors()["key"]["compressed"])[..60].to_string()),
                ..records()
            },
            "bad_records",
        ),
        (
            Records {
                nullifier: Some("12345".into()),
                ..records()
            },
            "bad_records",
        ),
        (
            Records {
                poh: Some(format!("eip155:1:tx:{TX}")),
                ..records()
            },
            "bad_records",
        ),
    ] {
        let v = verifier();
        *v.chain.latest.lock().unwrap() = change.clone();
        *v.chain.deep.lock().unwrap() = change;
        assert_eq!(
            refused(v.verify(&the_vectors_knock(), None, NOW).await),
            (3, code)
        );
    }
}

#[tokio::test]
async fn the_binding_is_for_this_key_human_and_name_final_and_young() {
    let v = verifier();
    let other_contract: Address = "0x639e41f70CbD1F1395BaC76De427D1469B46B190"
        .parse()
        .unwrap();
    let cases: [(Option<Receipt>, u64, &str); 6] = [
        (None, 37_300_100, "no_binding"),
        (
            Some(Receipt {
                ok: false,
                ..receipt()
            }),
            37_300_100,
            "no_binding",
        ),
        (
            Some(Receipt {
                logs: vec![bound(other_contract, namehash(&name()))],
                ..receipt()
            }),
            37_300_100,
            "no_binding",
        ),
        // D22: a binding for another name is no binding for this one
        (
            Some(Receipt {
                logs: vec![bound(
                    accepted_binding().unwrap(),
                    namehash("spare.itzraj.eth"),
                )],
                ..receipt()
            }),
            37_300_100,
            "no_binding",
        ),
        (Some(receipt()), 37_299_999, "binding_not_final"),
        (
            Some(Receipt {
                logs: vec![Log {
                    data: U256::from(NOW - 366 * 86_400).to_be_bytes::<32>().to_vec(),
                    ..receipt().logs[0].clone()
                }],
                ..receipt()
            }),
            37_300_100,
            "binding_expired",
        ),
    ];
    for (r, final_block, code) in cases {
        *v.chain.receipt.lock().unwrap() = r;
        *v.chain.final_block.lock().unwrap() = final_block;
        assert_eq!(
            refused(v.verify(&the_vectors_knock(), None, NOW).await),
            (6, code)
        );
    }
    // None of those used anything up
    *v.chain.receipt.lock().unwrap() = Some(receipt());
    *v.chain.final_block.lock().unwrap() = 37_300_000;
    v.verify(&the_vectors_knock(), None, NOW).await.unwrap();
}

#[tokio::test]
async fn another_human_than_the_names() {
    let v = verifier();
    let other = Records {
        nullifier: Some(format!("0x{}", "11".repeat(32))),
        ..records()
    };
    *v.chain.latest.lock().unwrap() = other.clone();
    *v.chain.deep.lock().unwrap() = other;
    assert_eq!(
        refused(v.verify(&the_vectors_knock(), None, NOW).await),
        (6, "wrong_human")
    );
}

#[tokio::test]
async fn the_challenge_is_ours_fresh_and_for_our_origin() {
    let v = verifier();
    let evil = knock(challenge(), "https://evil.example", 42, 1);
    assert_eq!(
        refused(v.verify(&evil, None, NOW).await),
        (2, "wrong_origin")
    );
    let never = knock(B256::repeat_byte(9), &origin(), 42, 1);
    assert_eq!(
        refused(v.verify(&never, None, NOW).await),
        (2, "bad_challenge")
    );
    assert_eq!(
        refused(
            v.verify(&the_vectors_knock(), None, NOW + CHALLENGE_TTL)
                .await
        ),
        (2, "bad_challenge")
    );
    let other_site = B256::repeat_byte(5);
    v.store.give(other_site, "https://other.example", NOW);
    assert_eq!(
        refused(
            v.verify(&knock(other_site, &origin(), 42, 1), None, NOW)
                .await
        ),
        (2, "wrong_origin")
    );
}

#[tokio::test]
async fn the_signature_is_the_names_key_over_this_knock() {
    let v = verifier();
    let mut k = the_vectors_knock();
    k["counter"] = json!(43);
    assert_eq!(refused(v.verify(&k, None, NOW).await), (4, "bad_signature"));
    // Signed for the right challenge, but by another key than ENS holds
    let other = SigningKey::from_slice(&[7u8; 32]).unwrap();
    let mut k = the_vectors_knock();
    let sig: Signature = other
        .sign_prehash(&hex::decode(s(&pass()["digest"])).unwrap())
        .unwrap();
    let sig = sig.normalize_s();
    k["r"] = json!(B256::from_slice(&sig.r().to_bytes()));
    k["s"] = json!(B256::from_slice(&sig.s().to_bytes()));
    assert_eq!(refused(v.verify(&k, None, NOW).await), (4, "bad_signature"));
}

#[tokio::test]
async fn fresh_mode_isnt_offered() {
    let v = verifier();
    assert_eq!(
        refused(
            v.verify(&knock(challenge(), &origin(), 42, 2), None, NOW)
                .await
        ),
        (7, "mode_unsupported")
    );
}

#[tokio::test]
async fn one_entry_per_human_for_an_action() {
    let v = verifier();
    v.verify(&the_vectors_knock(), Some("claim"), NOW)
        .await
        .unwrap();
    for c in [1, 2] {
        v.store.give(B256::repeat_byte(c), &origin(), NOW);
    }
    let again = v
        .verify(
            &knock(B256::repeat_byte(1), &origin(), 43, 1),
            Some("claim"),
            NOW,
        )
        .await;
    assert_eq!(refused(again), (8, "already_entered"));
    v.verify(
        &knock(B256::repeat_byte(1), &origin(), 43, 1),
        Some("vote"),
        NOW,
    )
    .await
    .unwrap();
    v.verify(&knock(B256::repeat_byte(2), &origin(), 44, 1), None, NOW)
        .await
        .unwrap();
}

#[tokio::test]
async fn whats_not_a_knock() {
    let v = verifier();
    let n = U256::from_be_bytes(alloy::primitives::hex!(
        "FFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551"
    ));
    let high_s = B256::from(n - U256::from_be_bytes(s(&pass()["s"]).parse::<B256>().unwrap().0));
    for change in [
        json!({"extra": 1}),
        json!({"v": 2}),
        json!({"s": high_s}),
        json!({"name": "Wedgie.itzraj.eth"}),
        json!({"name": "ab--c.itzraj.eth"}),
        json!({"deviceNode": namehash("spare.itzraj.eth")}),
        json!({"origin": "https://bouncer.example/path"}),
        json!({"origin": "http://bouncer.example"}),
        json!({"counter": 0}),
        json!({"mode": 3}),
        json!({"challenge": "0x1234"}),
    ] {
        let mut k = the_vectors_knock();
        for (f, x) in change.as_object().unwrap() {
            k[f] = x.clone();
        }
        assert_eq!(
            refused(v.verify(&k, None, NOW).await),
            (1, "bad_assertion"),
            "{change}"
        );
    }
    let mut k = the_vectors_knock();
    k.as_object_mut().unwrap().remove("humanRef");
    assert_eq!(refused(v.verify(&k, None, NOW).await), (1, "bad_assertion"));
}

#[tokio::test]
async fn a_chain_that_cant_be_read_takes_nothing() {
    let v = verifier();
    *v.chain.down.lock().unwrap() = true;
    assert_eq!(
        refused(v.verify(&the_vectors_knock(), None, NOW).await),
        (3, "unavailable")
    );
    *v.chain.down.lock().unwrap() = false;
    v.verify(&the_vectors_knock(), None, NOW).await.unwrap();
}

#[tokio::test]
async fn a_name_killed_while_its_deep_read_was_active_isnt_taken_on_that_read() {
    let v = verifier();
    // Killed at the latest block, still active 3 deep: no name, and nothing kept of the deep read
    *v.chain.latest.lock().unwrap() = Records::default();
    assert_eq!(
        refused(v.verify(&the_vectors_knock(), None, NOW).await),
        (3, "no_name")
    );
    // Named again in the last 3 blocks, the same records: deep isn't there yet, whatever was read before
    *v.chain.latest.lock().unwrap() = records();
    *v.chain.deep.lock().unwrap() = Records::default();
    assert_eq!(
        refused(v.verify(&the_vectors_knock(), None, NOW + 1).await),
        (3, "records_changing")
    );
}

#[tokio::test]
async fn deep_records_are_kept_a_minute_and_the_latest_never() {
    let v = verifier();
    for (c, counter, at) in [
        (1u8, 43u64, NOW),
        (2, 44, NOW + CACHE_TTL),
        (3, 45, NOW + CACHE_TTL + 1),
    ] {
        v.store.give(B256::repeat_byte(c), &origin(), at);
        v.verify(
            &knock(B256::repeat_byte(c), &origin(), counter, 1),
            None,
            at,
        )
        .await
        .unwrap();
    }
    let reads = v.chain.reads.lock().unwrap().clone();
    assert_eq!(reads, vec![HEAD, HEAD - DEPTH, HEAD, HEAD, HEAD - DEPTH]);
}

#[test]
fn names_and_origins() {
    for n in ["wedgie.itzraj.eth", "rpi.itzraj.eth", "a-b.c.eth", "x.eth"] {
        assert!(ok_name(n), "{n}");
    }
    for n in [
        "eth",
        "Wedgie.itzraj.eth",
        "a..eth",
        "ab--c.eth",
        "wedgie.itzraj.eth.",
        "wé.eth",
        "a_b.eth",
    ] {
        assert!(!ok_name(n), "{n}");
    }
    for o in [
        "https://bouncer.example",
        "https://a.b:8443",
        "http://localhost:3001",
        "http://127.0.0.1:3001",
    ] {
        assert!(ok_origin(o), "{o}");
    }
    for o in [
        "http://bouncer.example",
        "http://localhost.evil.example",
        "https://user@bouncer.example",
        "https://Bouncer.example",
        "https://bouncer.example/",
        "https://bouncer.example:",
        "https://bouncer.example:123456",
        "null",
    ] {
        assert!(!ok_origin(o), "{o}");
    }
}
