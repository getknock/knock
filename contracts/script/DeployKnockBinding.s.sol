// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";
import {KnockBinding, IWorldIDVerifier} from "../src/KnockBinding.sol";

/// Deploys KnockBinding on World Chain (480) against World ID 4.0's verifier: production, or staging with
/// KNOCK_STAGING=true (Simulator proofs only, R4). The RP is WORLD_RP_ID ("rp_" and 16 hex digits), the gas key
/// RELAYER_WALLET_PRIV_KEY: both from the repo's .env, never committed. Without --broadcast it only simulates.
///   forge script script/DeployKnockBinding.s.sol --rpc-url "$WORLD_RPC" [--broadcast]
contract DeployKnockBinding is Script {
    // world-id-protocol, contracts/deployments/core/{production,staging}.json: the WorldIDVerifier proxies (D2)
    address constant PRODUCTION = 0x00000000009E00F9FE82CfeeBB4556686da094d7;
    address constant STAGING = 0x703a6316c975DEabF30b637c155edD53e24657DB;

    function run() external returns (KnockBinding kb) {
        require(block.chainid == 480, "World Chain (480) only");
        bool staging = vm.envOr("KNOCK_STAGING", false);
        uint64 rp = rpId(vm.envString("WORLD_RP_ID"));
        vm.startBroadcast(vm.envUint("RELAYER_WALLET_PRIV_KEY"));
        kb = new KnockBinding(IWorldIDVerifier(staging ? STAGING : PRODUCTION), rp);
        vm.stopBroadcast();
    }

    /// "rp_" and 16 hex digits: the RP's uint64.
    function rpId(string memory rp) internal pure returns (uint64) {
        bytes memory b = bytes(rp);
        require(b.length == 19 && b[0] == "r" && b[1] == "p" && b[2] == "_", "WORLD_RP_ID: rp_ and 16 hex digits");
        bytes memory hex_ = new bytes(18);
        hex_[0] = "0";
        hex_[1] = "x";
        for (uint256 i = 3; i < 19; i++) {
            hex_[i - 1] = b[i];
        }
        return uint64(vm.parseUint(string(hex_)));
    }
}
