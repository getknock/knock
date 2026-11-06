//! knock-verifier: a site's Knock verifier (PLAN §3). The site's page gets a challenge here, has the Wedgie knock
//! through the Door, and hands the knock back; the answer is who knocked, or which check said no and why.
//! It reads ENS on mainnet through the Universal Resolver and bindings on World Chain, over public RPCs by default,
//! keeps what knocks use up in SQLite, and holds no keys.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use alloy::eips::{BlockId, BlockNumberOrTag};
use alloy::ens::{dns_encode, namehash};
use alloy::primitives::{Address, B256, Bytes, U256, address};
use alloy::providers::{DynProvider, Provider, ProviderBuilder};
use alloy::sol;
use alloy::sol_types::SolCall;
use anyhow::{Context, anyhow, ensure};
use axum::extract::rejection::JsonRejection;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use knock_verify::{
    Chain, Log, RECORDS, Receipt, Records, Refusal, Store, Strict, Unavailable, Verifier,
};
use serde::Deserialize;
use serde_json::{Value, json};
use tower_http::cors::{AllowOrigin, CorsLayer};

/// ENS's Universal Resolver on mainnet: the proxy viem reads names through.
const UNIVERSAL_RESOLVER: Address = address!("0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe");

sol! {
    #[sol(rpc)]
    interface UniversalResolver {
        function resolveWithGateways(bytes name, bytes data, string[] gateways) external view returns (bytes, address);
    }
    interface TextResolver {
        function text(bytes32 node, string key) external view returns (string);
    }
    #[sol(rpc)]
    interface KnockBinding {
        function VERSION() external view returns (uint256);
    }
}

/// An error's words with no URL in them: an RPC's URL can carry its key.
fn redact(e: impl std::fmt::Display) -> String {
    e.to_string()
        .split(' ')
        .map(|w| if w.contains("://") { "<url>" } else { w })
        .collect::<Vec<_>>()
        .join(" ")
}

struct Rpc {
    eth: DynProvider,
    world: DynProvider,
}

impl Rpc {
    /// One text record through the Universal Resolver, as viem's getEnsText reads it: empty is none, and so is a
    /// name with no resolver (a revert).
    async fn text(
        &self,
        name: &Bytes,
        node: B256,
        key: &str,
        block: u64,
    ) -> Result<Option<String>, Unavailable> {
        let data = TextResolver::textCall {
            node,
            key: key.into(),
        }
        .abi_encode();
        let ur = UniversalResolver::new(UNIVERSAL_RESOLVER, &self.eth);
        let call = ur
            .resolveWithGateways(
                name.clone(),
                data.into(),
                vec!["x-batch-gateway:true".into()],
            )
            .block(BlockId::number(block));
        match call.call().await {
            Ok(r) => Ok(TextResolver::textCall::abi_decode_returns(&r._0)
                .ok()
                .filter(|t| !t.is_empty())),
            Err(e) if reverted(&e) => Ok(None),
            Err(e) => Err(Unavailable(format!("mainnet: {}", redact(e)))),
        }
    }
}

fn reverted(e: &alloy::contract::Error) -> bool {
    match e {
        alloy::contract::Error::TransportError(t) => t
            .as_error_resp()
            .is_some_and(|p| p.message.contains("revert")),
        _ => false,
    }
}

impl Chain for Rpc {
    async fn head(&self) -> Result<u64, Unavailable> {
        self.eth
            .get_block_number()
            .await
            .map_err(|e| Unavailable(format!("mainnet: {}", redact(e))))
    }

    async fn records(&self, name: &str, block: u64) -> Result<Records, Unavailable> {
        let dns = Bytes::from(dns_encode(name));
        let node = namehash(name);
        let [a, b, c, d, e] = RECORDS;
        let texts = tokio::try_join!(
            self.text(&dns, node, a, block),
            self.text(&dns, node, b, block),
            self.text(&dns, node, c, block),
            self.text(&dns, node, d, block),
            self.text(&dns, node, e, block),
        )?;
        Ok(Records::from_texts(texts.into()))
    }

    async fn receipt(&self, tx: B256) -> Result<Option<Receipt>, Unavailable> {
        let r = self
            .world
            .get_transaction_receipt(tx)
            .await
            .map_err(|e| Unavailable(format!("World Chain: {}", redact(e))))?;
        Ok(r.map(|r| Receipt {
            ok: r.status(),
            block: r.block_number.unwrap_or(u64::MAX),
            logs: r
                .inner
                .logs()
                .iter()
                .map(|l| Log {
                    address: l.address(),
                    topics: l.topics().to_vec(),
                    data: l.data().data.to_vec(),
                })
                .collect(),
        }))
    }

    async fn final_block(&self, strict: Strict) -> Result<u64, Unavailable> {
        let tag = match strict {
            Strict::Finalized => BlockNumberOrTag::Finalized,
            Strict::Safe => BlockNumberOrTag::Safe,
            Strict::Off => BlockNumberOrTag::Latest, // never asked: a site that isn't strict takes any block
        };
        let b = self
            .world
            .get_block_by_number(tag)
            .await
            .map_err(|e| Unavailable(format!("World Chain: {}", redact(e))))?
            .ok_or_else(|| Unavailable("World Chain: no final block".into()))?;
        Ok(b.header.number)
    }
}

/// At most `max` in any `per`.
struct Window {
    max: usize,
    per: Duration,
    seen: Mutex<VecDeque<Instant>>,
}

impl Window {
    fn new(max: usize, per: Duration) -> Self {
        Window {
            max,
            per,
            seen: Mutex::new(VecDeque::new()),
        }
    }

    fn take(&self) -> Result<(), Refusal> {
        let now = Instant::now();
        let mut seen = self.seen.lock().unwrap();
        while seen
            .front()
            .is_some_and(|t| now.duration_since(*t) >= self.per)
        {
            seen.pop_front();
        }
        if seen.len() >= self.max {
            return Err(Refusal {
                check: 0,
                error: "busy",
                why: "the verifier's limit for now: try again later".into(),
            });
        }
        seen.push_back(now);
        Ok(())
    }
}

struct App {
    verifier: Verifier<Rpc>,
    challenges: Window,
    verifies: Window,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

/// A no: `{ok: false, check, error, why}`, with a status that says whose it is.
fn no(r: Refusal) -> Response {
    let status = match r.error {
        "unavailable" => StatusCode::SERVICE_UNAVAILABLE,
        "busy" => StatusCode::TOO_MANY_REQUESTS,
        "internal" => StatusCode::INTERNAL_SERVER_ERROR,
        _ if r.check == 1 => StatusCode::BAD_REQUEST,
        _ => StatusCode::FORBIDDEN,
    };
    (
        status,
        Json(json!({ "ok": false, "check": r.check, "error": r.error, "why": r.why })),
    )
        .into_response()
}

async fn health(State(app): State<Arc<App>>) -> Json<Value> {
    let v = &app.verifier;
    Json(json!({
        "ok": true,
        "origin": v.origin,
        "binding": v.contract,
        "maxBindingDays": v.max_binding_age / 86_400,
        "strict": v.strict,
    }))
}

async fn challenge(State(app): State<Arc<App>>) -> Response {
    match app
        .challenges
        .take()
        .and_then(|_| app.verifier.challenge(now()))
    {
        Ok(c) => Json(c).into_response(),
        Err(r) => no(r),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Knock {
    assertion: Value,
    /// The site's action, for one entry per human (V8): a-z, 0-9 and "-".
    action: Option<String>,
}

async fn verify(State(app): State<Arc<App>>, body: Result<Json<Knock>, JsonRejection>) -> Response {
    let bad = |why: &str| {
        no(Refusal {
            check: 1,
            error: "bad_assertion",
            why: why.into(),
        })
    };
    let Ok(Json(k)) = body else {
        return bad("the body is {assertion, action?}");
    };
    if let Some(a) = &k.action
        && (a.is_empty()
            || a.len() > 32
            || !a
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-'))
    {
        return bad("action: a-z, 0-9 and \"-\", up to 32");
    }
    if let Err(r) = app.verifies.take() {
        return no(r);
    }
    match app
        .verifier
        .verify(&k.assertion, k.action.as_deref(), now())
        .await
    {
        Ok(knocked) => {
            tracing::info!("let in {} (counter {})", knocked.name, knocked.counter);
            Json(json!({ "ok": true, "knock": knocked })).into_response()
        }
        Err(r) => {
            tracing::info!("refused at V{}: {}", r.check, r.error);
            no(r)
        }
    }
}

/// Before taking a knock: the RPCs are the chains they say, and the accepted KnockBinding is v3 on World Chain.
async fn check(v: &Verifier<Rpc>) -> anyhow::Result<()> {
    let id = v
        .chain
        .eth
        .get_chain_id()
        .await
        .map_err(|e| anyhow!(redact(e)))?;
    ensure!(id == 1, "VERIFIER_ETH_RPC is chain {id}, not mainnet");
    let id = v
        .chain
        .world
        .get_chain_id()
        .await
        .map_err(|e| anyhow!(redact(e)))?;
    ensure!(
        id == knock_verify::WORLD_CHAIN,
        "VERIFIER_WORLD_RPC is chain {id}, not World Chain"
    );
    let version = KnockBinding::new(v.contract, &v.chain.world)
        .VERSION()
        .call()
        .await
        .map_err(|e| anyhow!(redact(e)))?;
    ensure!(
        version == U256::from(3),
        "the accepted KnockBinding says it's v{version}, not v3"
    );
    let ur = v
        .chain
        .eth
        .get_code_at(UNIVERSAL_RESOLVER)
        .await
        .map_err(|e| anyhow!(redact(e)))?;
    ensure!(!ur.is_empty(), "no Universal Resolver on mainnet");
    Ok(())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().with_target(false).init();
    let env = |k: &str, d: &str| std::env::var(k).unwrap_or_else(|_| d.into());
    let origin = env("VERIFIER_ORIGIN", "http://localhost:3001");
    ensure!(
        knock_verify::ok_origin(&origin),
        "VERIFIER_ORIGIN: https://host[:port], or http://localhost[:port]"
    );
    // D26: not strict unless the site says so; strict waits for World Chain's safe head, or its finalized one
    let strict: Strict = env("VERIFIER_STRICT", "off")
        .parse()
        .map_err(|e| anyhow!("VERIFIER_STRICT: {e}"))?;
    let days: u64 = env("VERIFIER_MAX_BINDING_DAYS", "365")
        .parse()
        .context("VERIFIER_MAX_BINDING_DAYS: days")?;
    let url = |k: &str, d: &str| env(k, d).parse().map_err(|_| anyhow!("{k} isn't a URL"));
    let chain = Rpc {
        eth: ProviderBuilder::new()
            .connect_http(url(
                "VERIFIER_ETH_RPC",
                "https://ethereum-rpc.publicnode.com",
            )?)
            .erased(),
        world: ProviderBuilder::new()
            .connect_http(url(
                "VERIFIER_WORLD_RPC",
                "https://worldchain-mainnet.g.alchemy.com/public",
            )?)
            .erased(),
    };
    let store = Store::open(&env("VERIFIER_DB", "knock-verifier.db")).context("VERIFIER_DB")?;
    // Knock's KnockBinding, or a network of one's own: its KnockBinding v3 on World Chain (D34)
    let contract = match std::env::var("VERIFIER_KNOCK_BINDING") {
        Ok(a) => a
            .trim()
            .parse()
            .map_err(|_| anyhow!("VERIFIER_KNOCK_BINDING: 0x and 40 hex digits"))?,
        Err(_) => knock_verify::accepted_binding().map_err(anyhow::Error::msg)?,
    };
    let verifier =
        Verifier::new(chain, store, origin.clone(), contract, days * 86_400).strict(strict);
    check(&verifier).await?;
    tracing::info!(
        "checked: mainnet, World Chain, KnockBinding v3 at {contract}; knocks for {origin}; strict: {}",
        match strict {
            Strict::Off => "off (a binding counts once it's in a block)",
            Strict::Safe => "safe (a binding counts once World Chain has posted it to Ethereum)",
            Strict::Finalized =>
                "finalized (a binding counts once World Chain's post of it is final on Ethereum)",
        }
    );

    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::exact(HeaderValue::from_str(&origin)?))
        .allow_methods([Method::GET, Method::POST])
        .allow_headers([header::CONTENT_TYPE]);
    let app = App {
        verifier,
        challenges: Window::new(600, Duration::from_secs(3600)),
        verifies: Window::new(600, Duration::from_secs(3600)),
    };
    let router = Router::new()
        .route("/health", get(health))
        .route("/challenge", post(challenge))
        .route("/verify", post(verify))
        .layer(DefaultBodyLimit::max(16 * 1024))
        .layer(cors)
        .with_state(Arc::new(app));
    let addr = env("VERIFIER_ADDR", "127.0.0.1:8788");
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!("knock-verifier on http://{addr}");
    axum::serve(listener, router)
        .with_graceful_shutdown(async {
            tokio::signal::ctrl_c().await.ok();
        })
        .await?;
    Ok(())
}

/// Against the real chains, opt-in (`cargo test -p knock-verifier -- --ignored`): a killed name reads as no records,
/// and with KNOCK_LIVE_TX set to a v1 binding's transaction, its receipt reads whole and counts for nothing (D22).
#[cfg(test)]
mod live {
    use super::*;
    use knock_verify::{Wanted, check_binding};

    fn rpc() -> Rpc {
        Rpc {
            eth: ProviderBuilder::new()
                .connect_http("https://ethereum-rpc.publicnode.com".parse().unwrap())
                .erased(),
            world: ProviderBuilder::new()
                .connect_http(
                    "https://worldchain-mainnet.g.alchemy.com/public"
                        .parse()
                        .unwrap(),
                )
                .erased(),
        }
    }

    #[tokio::test]
    #[ignore]
    async fn the_chains_as_the_verifier_reads_them() {
        let rpc = rpc();
        let head = rpc.head().await.unwrap();
        assert_eq!(
            rpc.records("rpi.itzraj.eth", head).await.unwrap(),
            Records::default(),
            "killed: no records"
        );
        assert_eq!(
            rpc.records("rpi.itzraj.eth", head - 3).await.unwrap(),
            Records::default()
        );
        let final_block = rpc.final_block(Strict::Safe).await.unwrap();
        assert!(final_block < rpc.world.get_block_number().await.unwrap());
        assert!(rpc.final_block(Strict::Finalized).await.unwrap() <= final_block);
        let Ok(tx) = std::env::var("KNOCK_LIVE_TX") else {
            return;
        };
        let tx: B256 = tx.parse().unwrap();
        let r = rpc.receipt(tx).await.unwrap().expect("a receipt");
        assert!(r.ok && r.block <= final_block && !r.logs.is_empty());
        let wanted = Wanted {
            tx,
            contract: knock_verify::accepted_binding().unwrap(),
            nullifier: U256::from_be_bytes(
                r.logs.iter().find(|l| l.topics.len() == 3).unwrap().topics[1].0,
            ),
            key_hash: r.logs.iter().find(|l| l.topics.len() == 3).unwrap().topics[2],
            node: namehash("rpi.itzraj.eth"),
            final_block: Some((Strict::Safe, final_block)),
            now: now(),
            max_age: 365 * 86_400,
        };
        assert_eq!(
            check_binding(Some(&r), &wanted).unwrap_err().error,
            "no_binding",
            "a v1 binding counts for nothing"
        );
        assert_eq!(
            rpc.receipt(B256::repeat_byte(0xee))
                .await
                .unwrap()
                .map(|r| r.ok),
            None
        );
    }
}
