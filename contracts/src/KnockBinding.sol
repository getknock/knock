// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// World ID 4.0's on-chain verifier, as much as KnockBinding calls (worldcoin/world-id-protocol,
/// contracts/src/core/interfaces/IWorldIDVerifier.sol). It reverts on any proof it doesn't accept.
interface IWorldIDVerifier {
    function verify(
        uint256 nullifier,
        uint256 action,
        uint64 rpId,
        uint256 nonce,
        uint256 signalHash,
        uint64 expiresAtMin,
        uint64 issuerSchemaId,
        uint256 credentialGenesisIssuedAtMin,
        uint256[5] calldata zeroKnowledgeProof
    ) external view;
}

/// @title KnockBinding (v2)
/// @notice Binds a Knock device's P-256 key to one human, for one ENS name. Two yeses go in one call: the human's,
///   a World ID proof for the action "knock-bind" whose signal is the device's compressed key and then the name's
///   node, and the device's, its signature over KnockBind (made after a green press on the device). A `Bound` log
///   is the record; verifiers read it, and take it for that name only. So a lost device is no use under any other
///   name, and once its own name is gone (the kill switch), its binding counts nowhere. No storage, no owner, no
///   upgrades. Anyone may submit a binding: it says only what both yeses say.
///   v1 had no name in it: the same binding could be reused under any name, so verifiers take v2 bindings only.
contract KnockBinding {
    uint256 public constant VERSION = 2;
    /// Knock's EIP-712 domain: {name: "Knock", version: "1"}. No chain or contract: KnockBind names both.
    bytes32 public constant DOMAIN_SEPARATOR = keccak256(
        abi.encode(keccak256("EIP712Domain(string name,string version)"), keccak256("Knock"), keccak256("1"))
    );
    bytes32 public constant BIND_TYPEHASH =
        keccak256("KnockBind(uint256 chainId,address registry,uint256 nullifier,uint64 expiresAtMin,bytes key)");
    /// World ID's hash_to_field of the action: uint256(keccak256("knock-bind")) >> 8.
    uint256 public constant ACTION = uint256(keccak256("knock-bind")) >> 8;

    /// RIP-7212's P256VERIFY (on World Chain since Fjord): (digest, r, s, x, y) in; a word of 1 out when the
    /// signature holds for either s, nothing otherwise.
    address internal constant P256VERIFY = address(0x100);
    uint256 internal constant HALF_N = 0x7FFFFFFF800000007FFFFFFFFFFFFFFFDE737D56D38BCF4279DCE5617E3192A8;

    IWorldIDVerifier public immutable WORLD_ID;
    /// The Knock RP's World ID: its proofs' rpId, and the World ID key its nullifiers are made with.
    uint64 public immutable RP_ID;

    /// @notice The device whose key is (x, y), keyHash = keccak256(x || y), belongs to the human with this
    ///   nullifier, for the ENS name whose namehash is node, by a World ID proof whose credential lasts at least
    ///   until expiresAtMin (Unix seconds).
    event Bound(uint256 indexed nullifier, bytes32 indexed keyHash, bytes32 indexed node, uint64 expiresAtMin);

    /// The device's signature doesn't hold for this binding: another key, another binding, s high, or not a key.
    error NotSignedByDevice();
    /// A binding is for a name: node is its namehash, never zero.
    error NoName();

    constructor(IWorldIDVerifier worldId, uint64 rpId) {
        WORLD_ID = worldId;
        RP_ID = rpId;
    }

    /// @notice What the device signs to bind (x, y) to nullifier here: its knock_bind request's digest.
    function bindDigest(uint256 nullifier, uint64 expiresAtMin, bytes32 x, bytes32 y) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                BIND_TYPEHASH, block.chainid, address(this), nullifier, expiresAtMin, keccak256(_compressed(x, y))
            )
        );
        return keccak256(abi.encodePacked(hex"1901", DOMAIN_SEPARATOR, structHash));
    }

    /// @param nullifier The human's nullifier for "knock-bind", from the proof.
    /// @param nonce The proof request's nonce (the RP's, signed by it).
    /// @param expiresAtMin The proof's minimum credential expiry (Unix seconds), also signed by the device.
    /// @param issuerSchemaId The credential's issuer and schema, from the proof.
    /// @param genesisIssuedAtMin The proof's minimum credential genesis (0: none).
    /// @param proof The compressed Groth16 proof and the World ID Merkle root it was made against.
    /// @param x The device key's x.
    /// @param y The device key's y.
    /// @param node The namehash of the ENS name the device will have: the proof's signal ends with it.
    /// @param r The device's signature over bindDigest(nullifier, expiresAtMin, x, y): r.
    /// @param s The same signature's s, low (at most N/2): one signature, one form.
    function bind(
        uint256 nullifier,
        uint256 nonce,
        uint64 expiresAtMin,
        uint64 issuerSchemaId,
        uint256 genesisIssuedAtMin,
        uint256[5] calldata proof,
        bytes32 x,
        bytes32 y,
        bytes32 node,
        bytes32 r,
        bytes32 s
    ) external {
        if (node == bytes32(0)) revert NoName();
        bytes32 digest = bindDigest(nullifier, expiresAtMin, x, y);
        if (uint256(s) > HALF_N || !_p256(digest, r, s, x, y)) revert NotSignedByDevice();
        WORLD_ID.verify(
            nullifier,
            ACTION,
            RP_ID,
            nonce,
            uint256(keccak256(abi.encodePacked(_compressed(x, y), node))) >> 8, // IDKit's hash of the signal's bytes
            expiresAtMin,
            issuerSchemaId,
            genesisIssuedAtMin,
            proof
        );
        emit Bound(nullifier, keccak256(abi.encodePacked(x, y)), node, expiresAtMin);
    }

    /// The 33-byte compressed key: 02 or 03 by y's parity, then x. The device's knock_key, and the bind signal's start.
    function _compressed(bytes32 x, bytes32 y) internal pure returns (bytes memory) {
        return abi.encodePacked(uint256(y) & 1 == 1 ? bytes1(0x03) : bytes1(0x02), x);
    }

    function _p256(bytes32 digest, bytes32 r, bytes32 s, bytes32 x, bytes32 y) internal view returns (bool) {
        (bool ok, bytes memory out) = P256VERIFY.staticcall(abi.encode(digest, r, s, x, y));
        return ok && out.length == 32 && abi.decode(out, (uint256)) == 1;
    }
}
