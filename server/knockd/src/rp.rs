//! World ID RP signatures (docs.world.org/world-id/idkit/signatures): the RP's yes to one proof request.
//! World ID checks it against the signer in its RP registry before a proof is made, so only knockd, which
//! holds that key, can start a binding request for Knock: a first binding's, or a session proof's.

use alloy::primitives::{B256, keccak256};
use alloy::signers::{SignerSync, local::PrivateKeySigner};

/// keccak256, shifted right a byte: a field element, as World ID hashes actions, signals and nonces.
pub fn hash_to_field(input: &[u8]) -> B256 {
    let h = keccak256(input);
    let mut out = [0u8; 32];
    out[1..].copy_from_slice(&h[..31]);
    B256::from(out)
}

/// Version 1: 0x01, the nonce, created_at and expires_at (u64, big-endian), then the action's field
/// element when there is one (a uniqueness proof; a session proof has none).
pub fn message(nonce: B256, created_at: u64, expires_at: u64, action: Option<&str>) -> Vec<u8> {
    let mut m = Vec::with_capacity(81);
    m.push(1);
    m.extend_from_slice(nonce.as_slice());
    m.extend_from_slice(&created_at.to_be_bytes());
    m.extend_from_slice(&expires_at.to_be_bytes());
    if let Some(a) = action {
        m.extend_from_slice(hash_to_field(a.as_bytes()).as_slice());
    }
    m
}

pub struct RpSignature {
    pub nonce: B256,
    pub created_at: u64,
    pub expires_at: u64,
    /// r, s and v (27 or 28): an EIP-191 signature over the message.
    pub sig: [u8; 65],
}

/// The nonce is `random`'s field element; World's own signRequest does the same.
pub fn sign(
    key: &PrivateKeySigner,
    random: [u8; 32],
    created_at: u64,
    ttl: u64,
    action: Option<&str>,
) -> anyhow::Result<RpSignature> {
    let nonce = hash_to_field(&random);
    let expires_at = created_at + ttl;
    let sig = key.sign_message_sync(&message(nonce, created_at, expires_at, action))?;
    Ok(RpSignature {
        nonce,
        created_at,
        expires_at,
        sig: sig.as_bytes(),
    })
}

#[cfg(test)]
mod tests {
    // World's test vectors, from the page above.
    use super::*;
    use alloy::primitives::hex;

    fn h(s: &str) -> Vec<u8> {
        hex::decode(s).unwrap()
    }

    #[test]
    fn hash_to_field_vectors() {
        let cases: [(&[u8], &str); 4] = [
            (
                b"",
                "00c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a4",
            ),
            (
                b"test_signal",
                "00c1636e0a961a3045054c4d61374422c31a95846b8442f0927ad2ff1d6112ed",
            ),
            (
                &[1, 2, 3],
                "00f1885eda54b7a053318cd41e2093220dab15d65381b1157a3633a83bfd5c92",
            ),
            (
                b"hello",
                "001c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36dea",
            ),
        ];
        for (input, want) in cases {
            assert_eq!(hash_to_field(input).as_slice(), h(want));
        }
    }

    const NONCE: &str = "008ae1aa597fa146ebd3aa2ceddf360668dea5e526567e92b0321816a4e895bd";

    #[test]
    fn message_vectors() {
        let nonce = B256::from_slice(&h(NONCE));
        assert_eq!(
            message(nonce, 1700000000, 1700000300, None),
            h(
                "01008ae1aa597fa146ebd3aa2ceddf360668dea5e526567e92b0321816a4e895bd000000006553f100000000006553f22c"
            )
        );
        assert_eq!(
            message(nonce, 1700000000, 1700000300, Some("test-action")),
            h(concat!(
                "01008ae1aa597fa146ebd3aa2ceddf360668dea5e526567e92b0321816a4e895bd000000006553f100000000006553f22c",
                "00aa0ce59768ae5b1c52f07a9387f14f09f277422c0d2f8a268c7bad0c60a46a"
            ))
        );
    }

    #[test]
    fn sign_vectors() {
        let key: PrivateKeySigner =
            "abababababababababababababababababababababababababababababababab"
                .parse()
                .unwrap();
        let random: [u8; 32] = std::array::from_fn(|i| i as u8);
        let cases = [
            (
                None,
                "14f693175773aed912852a601e9c0fd30f2afe2738d31388316232ce6f64ae9e4edbfb19d81c4229ba9c9fca78ede4b28956b7ba4415f08d957cbc1b3bdaa4021b",
            ),
            (
                Some("test-action"),
                "05594adb6c1495768a38d523d7d6ee6356b2c31231919198794ed022ade7d08f73753f83bd167067d99c9b969d28e9222315837c66af25867b041273a6d5056f1b",
            ),
        ];
        for (action, want) in cases {
            let s = sign(&key, random, 1700000000, 300, action).unwrap();
            assert_eq!(s.nonce.as_slice(), h(NONCE));
            assert_eq!((s.created_at, s.expires_at), (1700000000, 1700000300));
            assert_eq!(s.sig.to_vec(), h(want));
        }
    }

    #[test]
    fn the_vectors_action_hashes_as_knockbinding_has_it() {
        // KnockBinding.ACTION of a deployment proving the vectors' action, and spec/vectors/v1.json's action hash
        assert_eq!(
            hash_to_field(b"knock-bind").as_slice(),
            h("0078fe652308f1e1b32627be3473d9fd4affd1e01a0e418fb0be6dfb8093601f")
        );
    }
}
