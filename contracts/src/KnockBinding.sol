// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// World ID 4.0's on-chain verifier, as much as KnockBinding calls (worldcoin/world-id-protocol,
/// contracts/src/core/interfaces/IWorldIDVerifier.sol). It reverts on any proof it doesn't accept.
interface IWorldIDVerifier {
    /// Any World ID proof, every public input given. A uniqueness proof that also made a session carries the
    /// session's commitment as its sessionId (`verify` would take 0 there), so a first binding is checked here.
    function verifyProofAndSignals(
        uint256 nullifier,
        uint256 action,
        uint64 rpId,
        uint256 nonce,
        uint256 signalHash,
        uint64 expiresAtMin,
        uint64 issuerSchemaId,
        uint256 credentialGenesisIssuedAtMin,
        uint256 sessionId,
        uint256[5] calldata zeroKnowledgeProof
    ) external view;

    /// A session proof: the World ID whose session this is, with a nullifier made for a random action.
    function verifySession(
        uint64 rpId,
        uint256 nonce,
        uint256 signalHash,
        uint64 expiresAtMin,
        uint64 issuerSchemaId,
        uint256 credentialGenesisIssuedAtMin,
        uint256 sessionId,
        uint256[2] calldata sessionNullifier,
        uint256[5] calldata zeroKnowledgeProof
    ) external view;
}

/// @title KnockBinding (v3)
/// @notice Binds a Knock device's P-256 key to one human, for one ENS name. Two yeses go in one call: the human's,
///   a World ID proof whose signal is the device's compressed key and then the name's node, and the device's, its
///   signature over KnockBind (made after a green press on the device). A `Bound` log is the record; verifiers
///   read it, and take it for that name only (D22). So a lost device is no use under any other name, and once its
///   own name is gone (the kill switch), its binding counts nowhere.
///
///   A human proves who they are once. World App discloses a nullifier for an action once: after ten minutes its
///   replay guard turns the same one down, for a year. So a human's first binding is a uniqueness proof for ACTION
///   that also starts a World ID session, and every binding after it, of another device or of one whose name was
///   killed, is a session proof for that session. Both bind for the same human: the nullifier the session was
///   made with. Sites see one human however many devices they have (D24).
///
///   Anyone may submit a binding: it says only what both yeses say. No owner, no upgrades.
///   v1 had no name in it; v2 asked World App for the same nullifier every time. Verifiers take v3 bindings only.
contract KnockBinding {
    uint256 public constant VERSION = 3;
    /// Knock's EIP-712 domain: {name: "Knock", version: "1"}. No chain or contract: KnockBind names both.
    bytes32 public constant DOMAIN_SEPARATOR = keccak256(
        abi.encode(keccak256("EIP712Domain(string name,string version)"), keccak256("Knock"), keccak256("1"))
    );
    bytes32 public constant BIND_TYPEHASH =
        keccak256("KnockBind(uint256 chainId,address registry,uint256 nullifier,uint64 expiresAtMin,bytes key)");

    /// RIP-7212's P256VERIFY (on World Chain since Fjord): (digest, r, s, x, y) in; a word of 1 out when the
    /// signature holds for either s, nothing otherwise.
    address internal constant P256VERIFY = address(0x100);
    uint256 internal constant HALF_N = 0x7FFFFFFF800000007FFFFFFFFFFFFFFFDE737D56D38BCF4279DCE5617E3192A8;

    IWorldIDVerifier public immutable WORLD_ID;
    /// The Knock RP's World ID: its proofs' rpId, and the World ID key its nullifiers are made with.
    uint64 public immutable RP_ID;
    /// World ID's hash_to_field of the action first bindings prove: uint256(keccak256(action)) >> 8. Each
    /// deployment names its own, so a new one gives every human a new first binding.
    uint256 public immutable ACTION;
    /// That action as IDKit asks World App for it.
    string public action;

    /// A World ID session a first binding started: the human it is (their nullifier for ACTION) and its oprf seed.
    /// World App proves it by its id, session_<commitment><oprfSeed> (64 bytes, hex). Not a secret: only the
    /// human's World ID can prove it.
    struct Session {
        uint256 nullifier;
        uint256 oprfSeed;
    }

    /// Sessions by their commitment (a session proof's sessionId), set by the first binding that carries one. The
    /// proof doesn't cover the seed, so a later submission of the same proof can't change it.
    mapping(uint256 commitment => Session) public sessions;
    /// Each human's latest session, by their nullifier: how the Console finds a returning human's.
    mapping(uint256 nullifier => uint256 commitment) public sessionOf;

    /// @notice The device whose key is (x, y), keyHash = keccak256(x || y), belongs to the human with this
    ///   nullifier, for the ENS name whose namehash is node, by a World ID proof whose credential lasts at least
    ///   until expiresAtMin (Unix seconds).
    event Bound(uint256 indexed nullifier, bytes32 indexed keyHash, bytes32 indexed node, uint64 expiresAtMin);
    /// @notice The human with this nullifier has a World ID session with Knock: its commitment, and its oprf seed.
    event Human(uint256 indexed nullifier, uint256 indexed commitment, uint256 oprfSeed);

    /// The device's signature doesn't hold for this binding: another key, another binding, s high, or not a key.
    error NotSignedByDevice();
    /// A binding is for a name: node is its namehash, never zero.
    error NoName();
    /// A first binding starts a session (its oprf seed starts 0x01): without one, its human couldn't bind again.
    error NoSession();
    /// bindAgain takes a session a first binding started, and a session proof (its action starts 0x02).
    error NotASession();

    constructor(IWorldIDVerifier worldId, uint64 rpId, string memory action_) {
        WORLD_ID = worldId;
        RP_ID = rpId;
        ACTION = uint256(keccak256(bytes(action_))) >> 8;
        action = action_;
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

    /// @notice A human's first binding: a World ID uniqueness proof for ACTION that started a session (IDKit's
    ///   session_id "create"). It records the session for the human, the first time it's seen.
    /// @param nullifier The human's nullifier for ACTION, from the proof.
    /// @param nonce The proof request's nonce (the RP's, signed by it).
    /// @param expiresAtMin The proof's minimum credential expiry (Unix seconds), also signed by the device.
    /// @param issuerSchemaId The credential's issuer and schema, from the proof.
    /// @param genesisIssuedAtMin The proof's minimum credential genesis (0: none).
    /// @param proof The compressed Groth16 proof and the World ID Merkle root it was made against.
    /// @param commitment The session's commitment: the first half of the result's session_id.
    /// @param oprfSeed The session's oprf seed: its second half.
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
        uint256 commitment,
        uint256 oprfSeed,
        bytes32 x,
        bytes32 y,
        bytes32 node,
        bytes32 r,
        bytes32 s
    ) external {
        if (commitment == 0 || oprfSeed >> 248 != 1) revert NoSession();
        _deviceSaysYes(nullifier, expiresAtMin, x, y, node, r, s);
        WORLD_ID.verifyProofAndSignals(
            nullifier,
            ACTION,
            RP_ID,
            nonce,
            _signalHash(x, y, node),
            expiresAtMin,
            issuerSchemaId,
            genesisIssuedAtMin,
            commitment,
            proof
        );
        if (sessions[commitment].nullifier == 0) {
            sessions[commitment] = Session(nullifier, oprfSeed);
            sessionOf[nullifier] = commitment;
            emit Human(nullifier, commitment, oprfSeed);
        }
        emit Bound(nullifier, keccak256(abi.encodePacked(x, y)), node, expiresAtMin);
    }

    /// @notice Every binding after a human's first: another device, or one bound again after its name was killed,
    ///   by a World ID session proof for a session their first binding started. It binds for that session's human.
    /// @param commitment The session's commitment: the session proof's sessionId.
    /// @param sessionNullifier The proof's session nullifier and the random action it was made for.
    /// @param r The device's signature over bindDigest(the session's nullifier, expiresAtMin, x, y): r.
    /// @dev The rest as in bind.
    function bindAgain(
        uint256 commitment,
        uint256[2] calldata sessionNullifier,
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
        uint256 nullifier = sessions[commitment].nullifier;
        if (nullifier == 0 || sessionNullifier[1] >> 248 != 2) revert NotASession();
        _deviceSaysYes(nullifier, expiresAtMin, x, y, node, r, s);
        WORLD_ID.verifySession(
            RP_ID,
            nonce,
            _signalHash(x, y, node),
            expiresAtMin,
            issuerSchemaId,
            genesisIssuedAtMin,
            commitment,
            sessionNullifier,
            proof
        );
        emit Bound(nullifier, keccak256(abi.encodePacked(x, y)), node, expiresAtMin);
    }

    /// The device's yes to this binding, for a name: its signature over bindDigest, s low.
    function _deviceSaysYes(
        uint256 nullifier,
        uint64 expiresAtMin,
        bytes32 x,
        bytes32 y,
        bytes32 node,
        bytes32 r,
        bytes32 s
    ) internal view {
        if (node == bytes32(0)) revert NoName();
        bytes32 digest = bindDigest(nullifier, expiresAtMin, x, y);
        if (uint256(s) > HALF_N || !_p256(digest, r, s, x, y)) revert NotSignedByDevice();
    }

    /// IDKit's hash of the signal's bytes: the device's compressed key, then the name's node.
    function _signalHash(bytes32 x, bytes32 y, bytes32 node) internal pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked(_compressed(x, y), node))) >> 8;
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
