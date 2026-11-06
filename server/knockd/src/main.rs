//! knockd: Knock's signer. It signs World ID RP contexts (`/rp-context`): for a human's first binding, a uniqueness
//! proof for the deployment's action that starts a session, and for every binding after it, a session proof
//! (D24). It sends `KnockBinding.bind()` or `bindAgain()` for a device that said yes on its own screen, the gas
//! key paying (`/bind`). It also reads a binding back from its transaction (`/bound`), for the Console to name the
//! device in ENS with, finds a Wedgie's latest binding by its key (`/binding`), and finds a returning human's
//! session (`/human`).
//!
//! Its secrets are read here and nowhere else (PLAN.md §5): the World RP key from its key file, and the gas key
//! and World Chain RPC from `.env`, as are the app's World IDs. None of them is ever logged or sent back, and
//! nothing about who asked is logged: no IPs.
//!
//!   cargo run -p knockd        (from the repo root; KNOCKD_ADDR, KNOCKD_ORIGINS, KNOCKD_ENV, WORLD_RP_KEY_FILE)

mod bind;
mod bindings;
mod rp;

use alloy::network::EthereumWallet;
use alloy::primitives::{Address, B256};
use alloy::providers::{DynProvider, Provider, ProviderBuilder};
use alloy::signers::local::PrivateKeySigner;
use alloy::sol;
use anyhow::{Context, bail, ensure};
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use rand::RngCore;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tower_http::cors::{AllowOrigin, CorsLayer};

pub const CHAIN_ID: u64 = 480;
/// The KnockBinding knockd sends to: v3, whose first bindings start World ID sessions (D24).
const VERSION: u64 = 3;
/// How long a signed request lasts: World's default.
const RP_TTL: u64 = 300;
/// Our KnockBinding deployments and World's contracts they use (D18: public protocol contracts).
const DEPLOYMENTS: &str = include_str!("../../../contracts/deployments/480.json");

sol! {
    #[sol(rpc)]
    interface RpRegistry {
        function getOprfKeyIdAndSigner(uint64 rpId) external view returns (uint160, address);
    }
}

/// One World ID environment: its KnockBinding and the action its first bindings prove, and World's verifier and
/// RP registry it answers to.
pub struct Env {
    pub name: &'static str,
    pub binding: Address,
    pub action: String,
    pub verifier: Address,
    pub registry: Address,
    /// The block it was deployed in: where its Bound logs start
    pub block: u64,
}

pub struct App {
    rp_key: PrivateKeySigner,
    app_id: String,
    rp_id: String,
    pub rp: u64,
    /// World Chain, through the gas key's wallet.
    pub chain: DynProvider,
    pub gas: Address,
    rpc: String,
    staging: Env,
    production: Env,
    contexts: Window,
    pub simulations: Window,
    pub sends: Window,
    pub lookups: Window,
    /// Every Bound so far, for /binding
    pub index: bindings::Index,
    /// One bind at a time: the gas key's nonces stay in order.
    pub sending: tokio::sync::Mutex<()>,
}

impl App {
    pub fn env(&self, name: &str) -> Result<&Env, Refusal> {
        match name {
            "staging" => Ok(&self.staging),
            "production" => Ok(&self.production),
            _ => Err(Refusal::bad(
                "environment: staging (Simulator proofs) or production",
            )),
        }
    }

    /// Both environments' contracts: where a Bound log can come from.
    pub fn envs(&self) -> [&Env; 2] {
        [&self.production, &self.staging]
    }

    /// An error's text with no URL in it: the RPC's URL carries its key.
    pub fn redact(&self, e: impl std::fmt::Display) -> String {
        let text = e.to_string().replace(&self.rpc, "<rpc>");
        text.split(' ')
            .map(|w| if w.contains("://") { "<url>" } else { w })
            .collect::<Vec<_>>()
            .join(" ")
    }
}

/// At most `max` in any `per`: when each was let through, and nothing else.
pub struct Window {
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

    pub fn take(&self) -> Result<(), Refusal> {
        let now = Instant::now();
        let mut seen = self.seen.lock().unwrap();
        while seen
            .front()
            .is_some_and(|t| now.duration_since(*t) >= self.per)
        {
            seen.pop_front();
        }
        if seen.len() >= self.max {
            return Err(Refusal::new(
                StatusCode::TOO_MANY_REQUESTS,
                "busy",
                "knockd's limit for now: try again later",
            ));
        }
        seen.push_back(now);
        Ok(())
    }
}

/// knockd's no: `{"error", "why"}`, like the device's knock_error.
#[derive(Debug)]
pub struct Refusal {
    status: StatusCode,
    error: &'static str,
    why: String,
}

impl Refusal {
    pub fn new(status: StatusCode, error: &'static str, why: impl Into<String>) -> Self {
        Refusal {
            status,
            error,
            why: why.into(),
        }
    }

    pub fn bad(why: impl Into<String>) -> Self {
        Refusal::new(StatusCode::BAD_REQUEST, "bad_request", why)
    }
}

impl IntoResponse for Refusal {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(json!({"error": self.error, "why": self.why})),
        )
            .into_response()
    }
}

#[derive(Deserialize)]
struct ContextRequest {
    /// staging or production: a first binding proves that KnockBinding's action. Production when not given.
    #[serde(default)]
    environment: Option<String>,
    /// For a binding by the human's session (bindAgain): its request names no action. Else a first binding.
    #[serde(default)]
    session: bool,
}

async fn rp_context(
    State(app): State<Arc<App>>,
    Json(q): Json<ContextRequest>,
) -> Result<Json<Value>, Refusal> {
    let env = app.env(q.environment.as_deref().unwrap_or("production"))?;
    let action = (!q.session).then_some(env.action.as_str());
    app.contexts.take()?;
    let mut random = [0u8; 32];
    rand::rng().fill_bytes(&mut random);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let s = rp::sign(&app.rp_key, random, now, RP_TTL, action).map_err(|_| {
        Refusal::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            "couldn't sign",
        )
    })?;
    tracing::info!(
        "rp-context: signed a {} request",
        action.map_or_else(|| "session".to_string(), |a| format!("{a} (first binding)"))
    );
    Ok(Json(json!({
        "app_id": app.app_id,
        "action": action,
        "rp_context": {
            "rp_id": app.rp_id,
            "nonce": s.nonce,
            "created_at": s.created_at,
            "expires_at": s.expires_at,
            "signature": format!("0x{}", alloy::primitives::hex::encode(s.sig)),
        },
    })))
}

async fn health(State(app): State<Arc<App>>) -> Json<Value> {
    Json(json!({
        "ok": true,
        "chainId": CHAIN_ID,
        "KnockBinding": {"staging": app.staging.binding, "production": app.production.binding},
        "action": {"staging": app.staging.action, "production": app.production.action},
    }))
}

fn var(name: &str) -> anyhow::Result<String> {
    std::env::var(name).with_context(|| format!("{name} is not set (.env)"))
}

fn envs() -> anyhow::Result<(Env, Env)> {
    let d: Value = serde_json::from_str(DEPLOYMENTS)?;
    ensure!(
        d["chainId"] == CHAIN_ID,
        "deployments: not chain {CHAIN_ID}"
    );
    let one = |name: &'static str| -> anyhow::Result<Env> {
        let a = |k: &str| -> anyhow::Result<Address> {
            d[name][k]
                .as_str()
                .with_context(|| format!("deployments: {name}.{k}"))?
                .parse()
                .map_err(Into::into)
        };
        ensure!(
            d[name]["version"] == VERSION,
            "deployments: {name} isn't KnockBinding v{VERSION}"
        );
        Ok(Env {
            name,
            binding: a("KnockBinding")?,
            action: d[name]["action"]
                .as_str()
                .filter(|s| !s.is_empty())
                .with_context(|| format!("deployments: {name}.action"))?
                .to_string(),
            verifier: a("WorldIDVerifier")?,
            registry: a("RpRegistry")?,
            block: d[name]["block"]
                .as_u64()
                .with_context(|| format!("deployments: {name}.block"))?,
        })
    };
    Ok((one("staging")?, one("production")?))
}

/// "rp_" and 16 hex digits: the RP's uint64, as KnockBinding was deployed with it.
fn rp_number(rp_id: &str) -> anyhow::Result<u64> {
    let hex = rp_id
        .strip_prefix("rp_")
        .filter(|h| h.len() == 16)
        .context("WORLD_RP_ID: rp_ and 16 hex digits")?;
    u64::from_str_radix(hex, 16).context("WORLD_RP_ID: rp_ and 16 hex digits")
}

/// Before serving: each KnockBinding is v3, proves the action the deployments say, and carries our RP and its
/// environment's verifier, and World's registry in each environment has our RP key as Knock's signer (else World
/// ID would turn down every request we sign).
async fn check(app: &App) -> anyhow::Result<()> {
    ensure!(
        app.chain
            .get_chain_id()
            .await
            .map_err(|e| anyhow::anyhow!(app.redact(e)))?
            == CHAIN_ID,
        "WORLD_RPC: not World Chain"
    );
    for env in [&app.staging, &app.production] {
        let kb = bind::KnockBinding::new(env.binding, &app.chain);
        let version = kb.VERSION().call().await.map_err(|e| {
            anyhow::anyhow!(
                "{}: no KnockBinding v{VERSION} there ({})",
                env.name,
                app.redact(e)
            )
        })?;
        ensure!(
            version == alloy::primitives::U256::from(VERSION),
            "{}: KnockBinding v{version}, not v{VERSION}",
            env.name
        );
        let action = kb
            .ACTION()
            .call()
            .await
            .map_err(|e| anyhow::anyhow!(app.redact(e)))?;
        ensure!(
            B256::from(action) == rp::hash_to_field(env.action.as_bytes())
                && kb
                    .action()
                    .call()
                    .await
                    .map_err(|e| anyhow::anyhow!(app.redact(e)))?
                    == env.action,
            "{}: KnockBinding proves another action than the deployments' {}",
            env.name,
            env.action
        );
        let rp = kb
            .RP_ID()
            .call()
            .await
            .map_err(|e| anyhow::anyhow!(app.redact(e)))?;
        ensure!(
            rp == app.rp,
            "{}: KnockBinding carries another RP than WORLD_RP_ID",
            env.name
        );
        let world = kb
            .WORLD_ID()
            .call()
            .await
            .map_err(|e| anyhow::anyhow!(app.redact(e)))?;
        ensure!(
            world == env.verifier,
            "{}: KnockBinding answers to another verifier",
            env.name
        );
        let signer = RpRegistry::new(env.registry, &app.chain)
            .getOprfKeyIdAndSigner(app.rp)
            .call()
            .await
            .map_err(|e| anyhow::anyhow!(app.redact(e)))?
            ._1;
        if signer != app.rp_key.address() {
            bail!(
                "{}: World's RP registry has another signer for this RP than the RP key file's key",
                env.name
            );
        }
    }
    Ok(())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().with_target(false).init();
    let env_file = std::env::var("KNOCKD_ENV").unwrap_or_else(|_| ".env".into());
    if let Err(e) = dotenvy::from_path(&env_file) {
        tracing::warn!(
            "{env_file} not read ({}); using the environment",
            if e.not_found() {
                "not found"
            } else {
                "unreadable"
            }
        );
    }
    let key_file =
        std::env::var("WORLD_RP_KEY_FILE").unwrap_or_else(|_| "knock-worldchain-key.json".into());
    let key: Value = serde_json::from_str(
        &std::fs::read_to_string(&key_file).with_context(|| format!("reading {key_file}"))?,
    )
    .with_context(|| format!("{key_file}: not JSON"))?;
    let rp_key: PrivateKeySigner = key["privateKey"]
        .as_str()
        .context("the RP key file has no privateKey")?
        .parse()
        .map_err(|_| anyhow::anyhow!("the RP key file's privateKey isn't a key"))?;
    let gas: PrivateKeySigner = var("RELAYER_WALLET_PRIV_KEY")?
        .parse()
        .map_err(|_| anyhow::anyhow!("RELAYER_WALLET_PRIV_KEY isn't a key"))?;
    let rpc = var("WORLD_RPC")?;
    let rp_id = var("WORLD_RP_ID")?;
    let (staging, production) = envs()?;
    let index = bindings::Index::new(staging.block.min(production.block));
    let app = App {
        rp: rp_number(&rp_id)?,
        rp_id,
        app_id: var("WORLD_APP_ID")?,
        rp_key,
        gas: gas.address(),
        chain: ProviderBuilder::new()
            .wallet(EthereumWallet::from(gas))
            .connect_http(
                rpc.parse()
                    .map_err(|_| anyhow::anyhow!("WORLD_RPC isn't a URL"))?,
            )
            .erased(),
        rpc,
        staging,
        production,
        contexts: Window::new(120, Duration::from_secs(3600)),
        simulations: Window::new(120, Duration::from_secs(3600)),
        sends: Window::new(12, Duration::from_secs(3600)),
        lookups: Window::new(600, Duration::from_secs(3600)),
        index,
        sending: tokio::sync::Mutex::new(()),
    };
    if std::env::var("KNOCKD_SKIP_CHECKS").is_err() {
        check(&app).await?;
        tracing::info!(
            "checked on World Chain: both KnockBindings are v3 with the deployments' actions and our RP, and World knows our RP key"
        );
    }

    let app = Arc::new(app);
    // Every binding so far, read once now, so the Console's first /binding is quick
    tokio::spawn({
        let app = app.clone();
        async move {
            match app.index.catch_up(&app).await {
                Ok(()) => tracing::info!("read World Chain's bindings"),
                Err(e) => {
                    tracing::warn!("reading World Chain's bindings: {e}; /binding tries again")
                }
            }
        }
    });

    let origins = std::env::var("KNOCKD_ORIGINS")
        .unwrap_or_else(|_| "http://localhost:3000,http://127.0.0.1:3000".into());
    let origins: Vec<HeaderValue> = origins
        .split(',')
        .map(|o| o.trim().parse())
        .collect::<Result<_, _>>()?;
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::list(origins))
        .allow_methods([Method::GET, Method::POST])
        .allow_headers([header::CONTENT_TYPE]);
    let router = Router::new()
        .route("/health", get(health))
        .route("/rp-context", post(rp_context))
        .route("/bind", post(bind::bind))
        .route("/bound", post(bind::bound))
        .route("/human", post(bind::human))
        .route("/binding", post(bindings::binding))
        .layer(DefaultBodyLimit::max(16 * 1024))
        .layer(cors)
        .with_state(app.clone());
    let addr = std::env::var("KNOCKD_ADDR").unwrap_or_else(|_| "127.0.0.1:8787".into());
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!("knockd on http://{addr}");
    axum::serve(listener, router)
        .with_graceful_shutdown(async {
            tokio::signal::ctrl_c().await.ok();
        })
        .await?;
    Ok(())
}

/// B256 from U256, for the 0x-and-64-hex form the device and the Console use.
pub fn word(n: alloy::primitives::U256) -> B256 {
    B256::from(n)
}
