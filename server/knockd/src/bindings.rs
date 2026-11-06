//! POST /binding: a Wedgie's latest binding, found by its key, so any browser knows it's bound before offering to
//! bind it again, and can name it with that binding. knockd keeps every Bound log from our two KnockBindings: it
//! reads World Chain from their deployments on, 100 blocks a request (all its RPC answers eth_getLogs for), and
//! catches up to the head each time it's asked. Nothing here is secret: a binding is on World Chain for anyone.

use crate::bind::{KnockBinding, bytes_of, device_key};
use crate::{App, CHAIN_ID, Refusal, word};
use alloy::primitives::{Address, B256, U256, keccak256};
use alloy::providers::Provider;
use alloy::rpc::types::Filter;
use alloy::sol_types::SolEvent;
use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;

/// Blocks per eth_getLogs, the RPC's most
const STEP: u64 = 100;
/// Requests at once while catching up
const AT_ONCE: usize = 8;

/// One Bound log, and where it is.
#[derive(Clone, Debug, PartialEq)]
pub struct Found {
    pub contract: Address,
    pub tx: B256,
    pub block: u64,
    pub nullifier: U256,
    pub key_hash: B256,
    pub node: B256,
    pub expires_at_min: u64,
}

/// Every Bound so far, oldest first, and the first block not read yet.
pub struct Index {
    state: tokio::sync::Mutex<(u64, Vec<Found>)>,
}

/// The requests from block `from` to `head`: STEP blocks each, at most `n` of them.
pub fn steps(from: u64, head: u64, n: usize) -> Vec<(u64, u64)> {
    let mut out = Vec::new();
    let mut a = from;
    while a <= head && out.len() < n {
        let b = (a + STEP - 1).min(head);
        out.push((a, b));
        a = b + 1;
    }
    out
}

impl Index {
    pub fn new(from: u64) -> Self {
        Index {
            state: tokio::sync::Mutex::new((from, Vec::new())),
        }
    }

    /// Read World Chain up to its head. One reader at a time; a failed request leaves the index where it was.
    pub async fn catch_up(&self, app: &App) -> Result<(), String> {
        let mut state = self.state.lock().await;
        let head = app
            .chain
            .get_block_number()
            .await
            .map_err(|e| app.redact(e))?;
        let contracts: Vec<Address> = app.envs().iter().map(|e| e.binding).collect();
        loop {
            let batch = steps(state.0, head, AT_ONCE);
            let Some(&(_, last)) = batch.last() else {
                return Ok(());
            };
            let mut set = tokio::task::JoinSet::new();
            for (a, b) in batch {
                let chain = app.chain.clone();
                let filter = Filter::new()
                    .address(contracts.clone())
                    .event_signature(KnockBinding::Bound::SIGNATURE_HASH)
                    .from_block(a)
                    .to_block(b);
                set.spawn(async move { (a, chain.get_logs(&filter).await) });
            }
            let mut read = Vec::new();
            while let Some(done) = set.join_next().await {
                let (a, logs) = done.map_err(|e| e.to_string())?;
                read.push((a, logs.map_err(|e| app.redact(e))?));
            }
            read.sort_by_key(|(a, _)| *a);
            for (_, logs) in read {
                for l in logs.iter().filter(|l| !l.removed) {
                    let (Some(tx), Some(block), Ok(b)) = (
                        l.transaction_hash,
                        l.block_number,
                        l.log_decode::<KnockBinding::Bound>(),
                    ) else {
                        continue;
                    };
                    let b = b.inner.data;
                    state.1.push(Found {
                        contract: l.address(),
                        tx,
                        block,
                        nullifier: b.nullifier,
                        key_hash: b.keyHash,
                        node: b.node,
                        expires_at_min: b.expiresAtMin,
                    });
                }
            }
            state.0 = last + 1;
        }
    }

    /// The latest binding of a key on one KnockBinding.
    pub async fn latest(&self, contract: Address, key_hash: B256) -> Option<Found> {
        let state = self.state.lock().await;
        state
            .1
            .iter()
            .rev()
            .find(|f| f.contract == contract && f.key_hash == key_hash)
            .cloned()
    }
}

#[derive(Deserialize)]
pub struct BindingRequest {
    environment: String,
    /// The Wedgie's compressed key
    key: String,
}

/// POST /binding: the Wedgie's latest binding in an environment, by its key, in /bound's shape.
pub async fn binding(
    State(app): State<Arc<App>>,
    Json(q): Json<BindingRequest>,
) -> Result<Json<Value>, Refusal> {
    let env = app.env(&q.environment)?;
    let key = bytes_of(&q.key, 33, "key")?;
    let (_, x, y) = device_key(&key).ok_or_else(|| Refusal::bad("key: a compressed P-256 key"))?;
    let key_hash = keccak256([x.as_slice(), y.as_slice()].concat());
    app.lookups.take()?;
    if let Err(e) = app.index.catch_up(&app).await {
        tracing::warn!("binding: reading World Chain's logs: {e}");
        return Err(Refusal::new(
            StatusCode::BAD_GATEWAY,
            "chain",
            "World Chain: reading the bindings failed; try again",
        ));
    }
    let f = app
        .index
        .latest(env.binding, key_hash)
        .await
        .ok_or_else(|| {
            Refusal::new(
                StatusCode::NOT_FOUND,
                "no_binding",
                format!("{}'s KnockBinding has never bound this Wedgie", env.name),
            )
        })?;
    Ok(Json(json!({
        "environment": env.name,
        "chainId": CHAIN_ID,
        "contract": env.binding,
        "tx": f.tx,
        "block": f.block,
        "poh": format!("eip155:{CHAIN_ID}:tx:{}", f.tx),
        "bound": {
            "nullifier": word(f.nullifier),
            "keyHash": f.key_hash,
            "node": f.node,
            "expiresAtMin": f.expires_at_min,
        },
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steps_are_100_blocks_and_stop_at_the_head() {
        assert_eq!(steps(1, 250, 8), vec![(1, 100), (101, 200), (201, 250)]);
        assert_eq!(steps(1, 100, 8), vec![(1, 100)]);
        assert_eq!(steps(5, 5, 8), vec![(5, 5)]);
        assert!(steps(6, 5, 8).is_empty());
    }

    #[test]
    fn steps_take_at_most_n_at_once() {
        let s = steps(0, 10_000, 8);
        assert_eq!(s.len(), 8);
        assert_eq!(s[7], (700, 799));
    }

    #[tokio::test]
    async fn the_latest_binding_of_a_key_on_one_contract() {
        let index = Index::new(0);
        let (a, b) = (Address::repeat_byte(1), Address::repeat_byte(2));
        let k = B256::repeat_byte(7);
        let found = |contract, block, key_hash| Found {
            contract,
            tx: B256::repeat_byte(block as u8),
            block,
            nullifier: U256::from(1),
            key_hash,
            node: B256::ZERO,
            expires_at_min: 0,
        };
        index.state.lock().await.1 = vec![
            found(a, 10, k),
            found(a, 20, k),
            found(b, 30, k),
            found(a, 40, B256::repeat_byte(8)),
        ];
        assert_eq!(index.latest(a, k).await.map(|f| f.block), Some(20));
        assert_eq!(index.latest(b, k).await.map(|f| f.block), Some(30));
        assert_eq!(index.latest(b, B256::repeat_byte(8)).await, None);
    }
}
