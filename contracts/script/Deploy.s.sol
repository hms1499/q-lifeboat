// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {GuardianVault} from "../src/GuardianVault.sol";

/// Deploys GuardianVault owned by the account derived from OWNER_MNEMONIC at m/44'/60'/0'/0/0
/// (the same path the SDK's deriveUnifiedAccount uses), with GUARDIAN_ADDRESS (the agent's EVM
/// address, the GAS_MNEMONIC account) as the immutable guardian that may call `rescue`.
/// No private key is read from the environment.
contract Deploy is Script {
    function run() external returns (GuardianVault vault) {
        require(block.chainid == 9800, "Deploy: diana (9800) only");
        // forge-lint: disable-next-line(unsafe-cheatcode)
        uint256 pk = vm.deriveKey(vm.envString("OWNER_MNEMONIC"), 0);
        return deploy(pk, vm.envAddress("GUARDIAN_ADDRESS"));
    }

    /// Checks and broadcast, without reading the environment (tests call this directly, since
    /// vm.setEnv is process-wide and forge runs tests in parallel).
    function deploy(uint256 pk, address guardian) public returns (GuardianVault vault) {
        require(block.chainid == 9800, "Deploy: diana (9800) only");
        address owner = vm.addr(pk);
        require(guardian != address(0), "Deploy: GUARDIAN_ADDRESS is zero");
        require(guardian != owner, "Deploy: GUARDIAN_ADDRESS is the owner");

        vm.startBroadcast(pk);
        vault = new GuardianVault(owner, guardian);
        vm.stopBroadcast();

        console.log("GuardianVault:", address(vault));
        console.log("owner:", owner);
        console.log("guardian:", guardian);
    }
}
