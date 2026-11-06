// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {P256} from "@openzeppelin/contracts/utils/cryptography/P256.sol";
import {KnockBinding, IWorldIDVerifier} from "../src/KnockBinding.sol";

/// RIP-7212's P256VERIFY in Solidity, for a test EVM without it (a Cancun one): a word of 1 when the signature
/// holds for either s, as the precompile answers (checked on World Chain), nothing otherwise.
contract P256Verify {
    uint256 constant N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;

    fallback(bytes calldata input) external returns (bytes memory) {
        if (input.length != 160) return "";
        (bytes32 h, bytes32 r, bytes32 s, bytes32 x, bytes32 y) =
            abi.decode(input, (bytes32, bytes32, bytes32, bytes32, bytes32));
        if (uint256(s) > N / 2 && uint256(s) < N) s = bytes32(N - uint256(s)); // OpenZeppelin's takes low s only
        return P256.verifySolidity(h, r, s, x, y) ? abi.encode(uint256(1)) : bytes("");
    }
}

/// World ID's verifier as KnockBinding sees it: every proof holds, none does, or only one made for one signal.
contract WorldIDStub is IWorldIDVerifier {
    bool public refuse;
    uint256 public signalOnly;

    error Refused();

    function setRefuse(bool r) external {
        refuse = r;
    }

    function setSignalOnly(uint256 h) external {
        signalOnly = h;
    }

    function verifyProofAndSignals(
        uint256,
        uint256,
        uint64,
        uint256,
        uint256 signalHash,
        uint64,
        uint64,
        uint256,
        uint256,
        uint256[5] calldata
    ) external view {
        holds(signalHash);
    }

    function verifySession(
        uint64,
        uint256,
        uint256 signalHash,
        uint64,
        uint64,
        uint256,
        uint256,
        uint256[2] calldata,
        uint256[5] calldata
    ) external view {
        holds(signalHash);
    }

    function holds(uint256 signalHash) internal view {
        if (refuse || (signalOnly != 0 && signalHash != signalOnly)) revert Refused();
    }
}

abstract contract Vectors is Test {
    uint256 constant N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;

    event Bound(uint256 indexed nullifier, bytes32 indexed keyHash, bytes32 indexed node, uint64 expiresAtMin);
    event Human(uint256 indexed nullifier, uint256 indexed commitment, uint256 oprfSeed);

    // A made-up World ID session: its commitment, and its oprf seed (0x01.., as World ID's are). And a session
    // proof's nullifier, with the random action it was made for (0x02.., as a session proof's is).
    uint256 constant SESSION = 0x5e5510;
    uint256 constant SEED = (1 << 248) | 0x5eed;
    uint256 constant SN = 0xabcdef;
    uint256 constant SA = (2 << 248) | 0xac7;

    string json;
    // spec/vectors/v1.json: its published test key, and its KnockBind
    uint256 secret;
    bytes32 x;
    bytes32 y;
    address registry;
    uint256 chain;
    uint256 nullifier;
    uint64 expiresAtMin;
    bytes32 r;
    bytes32 s;
    bytes32 node; // the vectors' device name's

    function readVectors() internal {
        json = vm.readFile("../spec/vectors/v1.json");
        secret = vm.parseJsonUint(json, ".key.secret");
        x = vm.parseJsonBytes32(json, ".key.x");
        y = vm.parseJsonBytes32(json, ".key.y");
        registry = vm.parseJsonAddress(json, ".structs.KnockBind.message.registry");
        chain = vm.parseJsonUint(json, ".structs.KnockBind.message.chainId");
        nullifier = vm.parseJsonUint(json, ".structs.KnockBind.message.nullifier");
        expiresAtMin = uint64(vm.parseJsonUint(json, ".structs.KnockBind.message.expiresAtMin"));
        r = vm.parseJsonBytes32(json, ".structs.KnockBind.r");
        s = vm.parseJsonBytes32(json, ".structs.KnockBind.s");
        node = vm.parseJsonBytes32(json, ".device.node");
    }

    /// The test EVM's P256VERIFY, or the Solidity one where it has none.
    function p256Precompile() internal {
        bytes32 d = vm.parseJsonBytes32(json, ".structs.KnockBind.digest");
        (bool ok, bytes memory out) = address(0x100).staticcall(abi.encode(d, r, s, x, y));
        if (!(ok && out.length == 32)) vm.etch(address(0x100), address(new P256Verify()).code);
    }

    /// The device's yes, as the wedgie makes it: a P-256 signature over bindDigest, s low.
    function signed(KnockBinding kb, uint256 key, uint256 n, uint64 e) internal view returns (bytes32, bytes32) {
        (uint256 px, uint256 py) = vm.publicKeyP256(key);
        (bytes32 r_, bytes32 s_) = vm.signP256(key, kb.bindDigest(n, e, bytes32(px), bytes32(py)));
        return (r_, uint256(s_) > N / 2 ? bytes32(N - uint256(s_)) : s_);
    }
}

contract KnockBindingTest is Vectors {
    uint256 constant P = 0xFFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF;
    uint64 constant RP = 0x0123456789abcdef; // a made-up RP

    WorldIDStub world;
    KnockBinding kb;
    uint256[5] proof = [uint256(1), 2, 3, 4, 5];

    function setUp() public {
        readVectors();
        vm.chainId(chain);
        world = new WorldIDStub();
        deployCodeTo(
            "KnockBinding.sol:KnockBinding",
            abi.encode(address(world), RP, vm.parseJsonString(json, ".action.name")),
            registry
        );
        kb = KnockBinding(registry);
        p256Precompile();
    }

    /// The vectors' binding as the human's first: a uniqueness proof that started SESSION.
    function first() internal {
        kb.bind(nullifier, 7, expiresAtMin, 1, 0, proof, SESSION, SEED, x, y, node, r, s);
    }

    /// A binding by a session proof for SESSION: a device's key and yes, for a name.
    function again(bytes32 x_, bytes32 y_, bytes32 nd, bytes32 r_, bytes32 s_) internal {
        kb.bindAgain(SESSION, [SN, SA], 8, expiresAtMin, 1, 0, proof, x_, y_, nd, r_, s_);
    }

    function test_vectors() public view {
        assertEq(kb.DOMAIN_SEPARATOR(), vm.parseJsonBytes32(json, ".domain.separator"), "domain");
        assertEq(kb.BIND_TYPEHASH(), vm.parseJsonBytes32(json, ".structs.KnockBind.typeHash"), "KnockBind's type hash");
        assertEq(kb.ACTION(), vm.parseJsonUint(json, ".action.hash"), "the action, hashed to the field");
        assertEq(kb.action(), vm.parseJsonString(json, ".action.name"), "the action, as IDKit asks for it");
        assertEq(
            kb.bindDigest(nullifier, expiresAtMin, x, y),
            vm.parseJsonBytes32(json, ".structs.KnockBind.digest"),
            "the vectors' KnockBind digest, at their registry on their chain"
        );
        assertEq(address(kb.WORLD_ID()), address(world));
        assertEq(kb.RP_ID(), RP);
        assertEq(kb.VERSION(), 3);
    }

    /// Each deployment proves its own action, and a new one is a new first binding for every human (D24).
    function test_theActionIsTheDeployments() public {
        KnockBinding other = new KnockBinding(world, RP, "knock-human");
        assertEq(other.ACTION(), uint256(keccak256("knock-human")) >> 8);
        assertEq(other.action(), "knock-human");
    }

    /// The vectors' binding, as a human's first: World ID asked about exactly this proof, signal (key, then
    /// node), RP and session. The session is the human's from then on, and Human and Bound say so.
    function test_bind() public {
        uint256 signalHash = vm.parseJsonUint(json, ".bind.signalHash");
        vm.expectCall(
            address(world),
            abi.encodeCall(
                IWorldIDVerifier.verifyProofAndSignals,
                (nullifier, kb.ACTION(), RP, 7, signalHash, expiresAtMin, 1, 0, SESSION, proof)
            )
        );
        vm.expectEmit(address(kb));
        emit Human(nullifier, SESSION, SEED);
        vm.expectEmit(address(kb));
        emit Bound(nullifier, vm.parseJsonBytes32(json, ".key.keyHash"), node, expiresAtMin);
        first();
        (uint256 human, uint256 seed) = kb.sessions(SESSION);
        assertEq(human, nullifier, "the session's human");
        assertEq(seed, SEED, "its seed");
        assertEq(kb.sessionOf(nullifier), SESSION, "found by the human");
    }

    /// The same Wedgie bound again by a session proof, after its name was killed: World ID is asked about that
    /// session proof, and Bound names the session's human, with no uniqueness proof asked again.
    function test_bindAgain() public {
        first();
        uint256 signalHash = vm.parseJsonUint(json, ".bind.signalHash");
        vm.expectCall(
            address(world),
            abi.encodeCall(
                IWorldIDVerifier.verifySession, (RP, 8, signalHash, expiresAtMin, 1, 0, SESSION, [SN, SA], proof)
            )
        );
        vm.expectEmit(address(kb));
        emit Bound(nullifier, vm.parseJsonBytes32(json, ".key.keyHash"), node, expiresAtMin);
        again(x, y, node, r, s);
    }

    /// Another Wedgie for the same human, with its own key and name: Bound names the same human, so sites see one.
    function test_bindAgain_anotherWedgie() public {
        first();
        (uint256 px, uint256 py) = vm.publicKeyP256(0xb0b);
        (bytes32 r_, bytes32 s_) = signed(kb, 0xb0b, nullifier, expiresAtMin);
        bytes32 nd = keccak256("another Wedgie's name's node");
        vm.expectEmit(address(kb));
        emit Bound(nullifier, keccak256(abi.encodePacked(px, py)), nd, expiresAtMin);
        again(bytes32(px), bytes32(py), nd, r_, s_);
    }

    /// The device says yes for the session's human: its yes for anyone else's nullifier doesn't hold.
    function test_bindAgain_refuses_aYesForAnotherHuman() public {
        first();
        (uint256 px, uint256 py) = vm.publicKeyP256(0xb0b);
        (bytes32 r_, bytes32 s_) = signed(kb, 0xb0b, nullifier ^ 1, expiresAtMin);
        vm.expectCall(address(world), abi.encodeWithSelector(IWorldIDVerifier.verifySession.selector), 0);
        vm.expectRevert(KnockBinding.NotSignedByDevice.selector);
        again(bytes32(px), bytes32(py), node, r_, s_);
    }

    function test_bindAgain_refuses_aSessionNoFirstBindingStarted() public {
        vm.expectCall(address(world), abi.encodeWithSelector(IWorldIDVerifier.verifySession.selector), 0);
        vm.expectRevert(KnockBinding.NotASession.selector);
        again(x, y, node, r, s);
    }

    /// A uniqueness proof's action (0x00..) isn't a session proof's (0x02..): a first binding's proof can't be
    /// passed off as a session proof.
    function test_bindAgain_refuses_aUniquenessProof() public {
        first();
        uint256 uniqueness = kb.ACTION();
        vm.expectRevert(KnockBinding.NotASession.selector);
        kb.bindAgain(SESSION, [nullifier, uniqueness], 7, expiresAtMin, 1, 0, proof, x, y, node, r, s);
    }

    /// A first binding without a session would leave its human unable to bind again: World App won't prove the
    /// same nullifier twice.
    function test_bind_refuses_noSession() public {
        vm.expectRevert(KnockBinding.NoSession.selector);
        kb.bind(nullifier, 7, expiresAtMin, 1, 0, proof, 0, SEED, x, y, node, r, s);
        vm.expectRevert(KnockBinding.NoSession.selector);
        kb.bind(nullifier, 7, expiresAtMin, 1, 0, proof, SESSION, 0x5eed, x, y, node, r, s); // not a seed: no 0x01
    }

    /// The proof doesn't cover the seed, so the first submission's stands: the same proof sent again with another
    /// seed changes nothing, and says nothing of a session.
    function test_bind_theFirstSeedStands() public {
        first();
        vm.recordLogs();
        kb.bind(nullifier, 7, expiresAtMin, 1, 0, proof, SESSION, SEED + 1, x, y, node, r, s);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1, "Bound only");
        (, uint256 seed) = kb.sessions(SESSION);
        assertEq(seed, SEED);
    }

    /// A newer session of the same human (a first binding again, inside World App's ten minutes) is the one
    /// found, and the older keeps working.
    function test_bind_aNewerSessionIsFound() public {
        first();
        kb.bind(nullifier, 7, expiresAtMin, 1, 0, proof, SESSION + 1, SEED, x, y, node, r, s);
        assertEq(kb.sessionOf(nullifier), SESSION + 1);
        again(x, y, node, r, s);
    }

    /// The human's proof names the name: replayed for another name (the device's signature holds for any), World
    /// ID is asked about another signal and says no. So a lost device can't take its binding to a new name (D22).
    function test_aProofForOneNameIsNoProofForAnother() public {
        world.setSignalOnly(vm.parseJsonUint(json, ".bind.signalHash"));
        first();
        vm.expectRevert(WorldIDStub.Refused.selector);
        kb.bind(nullifier, 7, expiresAtMin, 1, 0, proof, SESSION, SEED, x, y, keccak256("another name's node"), r, s);
        vm.expectRevert(WorldIDStub.Refused.selector);
        again(x, y, keccak256("another name's node"), r, s);
    }

    function test_refuses_noName() public {
        vm.expectCall(address(world), abi.encodeWithSelector(IWorldIDVerifier.verifyProofAndSignals.selector), 0);
        vm.expectRevert(KnockBinding.NoName.selector);
        kb.bind(nullifier, 7, expiresAtMin, 1, 0, proof, SESSION, SEED, x, y, bytes32(0), r, s);
    }

    function test_bindAgain_refuses_noName() public {
        first();
        vm.expectCall(address(world), abi.encodeWithSelector(IWorldIDVerifier.verifySession.selector), 0);
        vm.expectRevert(KnockBinding.NoName.selector);
        again(x, y, bytes32(0), r, s);
    }

    function refused(KnockBinding at, uint256 n, uint64 e, bytes32 x_, bytes32 y_, bytes32 r_, bytes32 s_) internal {
        vm.expectCall(address(world), abi.encodeWithSelector(IWorldIDVerifier.verifyProofAndSignals.selector), 0);
        vm.expectRevert(KnockBinding.NotSignedByDevice.selector);
        at.bind(n, 7, e, 1, 0, proof, SESSION, SEED, x_, y_, node, r_, s_);
    }

    function test_refuses_anotherR() public {
        refused(kb, nullifier, expiresAtMin, x, y, bytes32(uint256(r) + 1), s);
    }

    /// The same signature with s high holds on P256VERIFY (World Chain's too): KnockBinding takes one form only.
    function test_refuses_highS() public {
        (bool ok, bytes memory out) = address(0x100)
            .staticcall(abi.encode(kb.bindDigest(nullifier, expiresAtMin, x, y), r, bytes32(N - uint256(s)), x, y));
        assertTrue(ok && out.length == 32, "the high-s twin holds on P256VERIFY");
        refused(kb, nullifier, expiresAtMin, x, y, r, bytes32(N - uint256(s)));
    }

    function test_refuses_anotherHuman() public {
        refused(kb, nullifier ^ 1, expiresAtMin, x, y, r, s);
    }

    function test_refuses_anotherExpiry() public {
        refused(kb, nullifier, expiresAtMin + 1, x, y, r, s);
    }

    /// (x, P - y) is the other key with this x: compressed 03.. instead of 02..
    function test_refuses_theOtherKeyWithThisX() public {
        refused(kb, nullifier, expiresAtMin, x, bytes32(P - uint256(y)), r, s);
    }

    function test_refuses_notAKey() public {
        refused(kb, nullifier, expiresAtMin, bytes32(uint256(1)), bytes32(uint256(1)), r, s);
    }

    function test_refuses_zeroSignature() public {
        refused(kb, nullifier, expiresAtMin, x, y, bytes32(0), bytes32(0));
    }

    function test_refuses_anotherChain() public {
        vm.chainId(1);
        refused(kb, nullifier, expiresAtMin, x, y, r, s);
    }

    function test_refuses_anotherRegistry() public {
        refused(new KnockBinding(world, RP, "knock-bind"), nullifier, expiresAtMin, x, y, r, s);
    }

    function test_aWorldIdRefusalStands() public {
        first();
        world.setRefuse(true);
        vm.expectRevert(WorldIDStub.Refused.selector);
        first();
        vm.expectRevert(WorldIDStub.Refused.selector);
        again(x, y, node, r, s);
    }

    /// Any key, either parity of y, any name, any session: the signal hashes its compressed form and the node,
    /// the session goes to World ID as the proof's, and Bound has keccak256(x || y) and the node.
    function testFuzz_bind(uint256 key, uint256 n, uint64 e, uint256 nonce, bytes32 nd, uint256 c, uint248 seed)
        public
    {
        key = bound(key, 1, N - 1);
        vm.assume(nd != bytes32(0) && c != 0 && n != 0);
        uint256 oprfSeed = (1 << 248) | seed;
        (uint256 px, uint256 py) = vm.publicKeyP256(key);
        (bytes32 r_, bytes32 s_) = signed(kb, key, n, e);
        bytes memory compressed = abi.encodePacked(py % 2 == 1 ? bytes1(0x03) : bytes1(0x02), px);
        vm.expectCall(
            address(world),
            abi.encodeCall(
                IWorldIDVerifier.verifyProofAndSignals,
                (
                    n,
                    kb.ACTION(),
                    RP,
                    nonce,
                    uint256(keccak256(abi.encodePacked(compressed, nd))) >> 8,
                    e,
                    1,
                    0,
                    c,
                    proof
                )
            )
        );
        vm.expectEmit(address(kb));
        emit Bound(n, keccak256(abi.encodePacked(px, py)), nd, e);
        kb.bind(n, nonce, e, 1, 0, proof, c, oprfSeed, bytes32(px), bytes32(py), nd, r_, s_);
        (uint256 human, uint256 got) = kb.sessions(c);
        assertEq(human, n);
        assertEq(got, oprfSeed);
    }

    /// Any key, any name, bound again for the vectors' human by their session: World ID gets the session proof
    /// as it came, and Bound names that human.
    function testFuzz_bindAgain(uint256 key, uint64 e, uint256 nonce, bytes32 nd, uint256 sn, uint248 sa) public {
        key = bound(key, 1, N - 1);
        vm.assume(nd != bytes32(0));
        first();
        uint256 act = (2 << 248) | sa;
        (uint256 px, uint256 py) = vm.publicKeyP256(key);
        (bytes32 r_, bytes32 s_) = signed(kb, key, nullifier, e);
        bytes memory compressed = abi.encodePacked(py % 2 == 1 ? bytes1(0x03) : bytes1(0x02), px);
        vm.expectCall(
            address(world),
            abi.encodeCall(
                IWorldIDVerifier.verifySession,
                (
                    RP,
                    nonce,
                    uint256(keccak256(abi.encodePacked(compressed, nd))) >> 8,
                    e,
                    1,
                    0,
                    SESSION,
                    [sn, act],
                    proof
                )
            )
        );
        vm.expectEmit(address(kb));
        emit Bound(nullifier, keccak256(abi.encodePacked(px, py)), nd, e);
        kb.bindAgain(SESSION, [sn, act], nonce, e, 1, 0, proof, bytes32(px), bytes32(py), nd, r_, s_);
    }
}

/// World ID's errors on the way to a proof, in the order its verifier checks (world-id-protocol, WorldIDVerifier.sol)
interface WorldIDErrors {
    error InvalidMerkleRoot();
    error UnregisteredIssuerSchemaId();
    error ExpirationTooOld();
    error ProofInvalid();
}

interface WorldIDRegistry {
    function getLatestRoot() external view returns (uint256);
}

/// KnockBinding against World's real verifier on a World Chain fork (WORLD_RPC and WORLD_RP_ID set; skipped
/// otherwise). A made-up proof goes as far as it can: each argument lands where World's verifier reads it.
contract KnockBindingForkTest is Vectors {
    address constant WORLD_ID_VERIFIER = 0x00000000009E00F9FE82CfeeBB4556686da094d7; // production (D2)
    address constant WORLD_ID_REGISTRY = 0x0000000000aE079eB8a274cD51c0f44a9E4d67d4;
    uint64 constant ISSUER = 1; // registered in production and staging (checked 2026-11-06)

    KnockBinding kb;
    uint256 root;

    function setUp() public {
        string memory rpc = vm.envOr("WORLD_RPC", string(""));
        string memory rp = vm.envOr("WORLD_RP_ID", string(""));
        vm.skip(bytes(rpc).length == 0 || bytes(rp).length == 0);
        vm.createSelectFork(rpc);
        readVectors();
        kb = new KnockBinding(IWorldIDVerifier(WORLD_ID_VERIFIER), rpId(rp), vm.parseJsonString(json, ".action.name"));
        root = WorldIDRegistry(WORLD_ID_REGISTRY).getLatestRoot();
        p256Precompile();
    }

    /// "rp_" and 16 hex digits: the RP's uint64.
    function rpId(string memory rp) internal pure returns (uint64) {
        bytes memory b = bytes(rp);
        bytes memory hex_ = new bytes(b.length - 1);
        hex_[0] = "0";
        hex_[1] = "x";
        for (uint256 i = 3; i < b.length; i++) {
            hex_[i - 1] = b[i];
        }
        return uint64(vm.parseUint(string(hex_)));
    }

    function attempt(uint64 issuer, uint64 e, uint256 root_, bytes4 err) internal {
        (bytes32 r_, bytes32 s_) = signed(kb, secret, nullifier, e);
        vm.expectRevert(err);
        kb.bind(nullifier, 7, e, issuer, 0, [uint256(1), 2, 3, 4, root_], SESSION, SEED, x, y, node, r_, s_);
    }

    function attemptAgain(uint64 issuer, uint64 e, uint256 root_, bytes4 err) internal {
        (bytes32 r_, bytes32 s_) = signed(kb, secret, nullifier, e);
        vm.expectRevert(err);
        kb.bindAgain(SESSION, [SN, SA], 7, e, issuer, 0, [uint256(1), 2, 3, 4, root_], x, y, node, r_, s_);
    }

    function test_fork_eachArgumentReachesWorldID() public {
        uint64 fresh = uint64(block.timestamp);
        attempt(ISSUER, fresh, 0, WorldIDErrors.InvalidMerkleRoot.selector); // proof[4] is the root
        attempt(2, fresh, root, WorldIDErrors.UnregisteredIssuerSchemaId.selector); // the issuer goes through
        attempt(ISSUER, fresh - 18001, root, WorldIDErrors.ExpirationTooOld.selector); // and expiresAtMin
        attempt(ISSUER, fresh, root, WorldIDErrors.ProofInvalid.selector); // the RP's key found: the proof's checked
    }

    /// The same for a session proof, once a session is the vectors' human's (written in: `action` is slot 0,
    /// `sessions` slot 1, and a Session's nullifier its first word).
    function test_fork_eachSessionArgumentReachesWorldID() public {
        vm.store(address(kb), keccak256(abi.encode(SESSION, uint256(1))), bytes32(nullifier));
        (uint256 human,) = kb.sessions(SESSION);
        assertEq(human, nullifier, "the session is the vectors' human's");
        uint64 fresh = uint64(block.timestamp);
        attemptAgain(ISSUER, fresh, 0, WorldIDErrors.InvalidMerkleRoot.selector);
        attemptAgain(2, fresh, root, WorldIDErrors.UnregisteredIssuerSchemaId.selector);
        attemptAgain(ISSUER, fresh - 18001, root, WorldIDErrors.ExpirationTooOld.selector);
        attemptAgain(ISSUER, fresh, root, WorldIDErrors.ProofInvalid.selector);
    }
}
