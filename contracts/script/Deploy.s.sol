// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {GuardianVault} from "../src/GuardianVault.sol";

/// Deploys GuardianVault owned by the account derived from OWNER_MNEMONIC at m/44'/60'/0'/0/0
/// (the same path the SDK's deriveUnifiedAccount uses). No private key is read from the environment.
contract Deploy is Script {
    function run() external returns (GuardianVault vault) {
        require(block.chainid == 9800, "Deploy: diana (9800) only");
        // forge-lint: disable-next-line(unsafe-cheatcode)
        uint256 pk = vm.deriveKey(vm.envString("OWNER_MNEMONIC"), 0);
        address owner = vm.addr(pk);

        vm.startBroadcast(pk);
        vault = new GuardianVault(owner);
        vm.stopBroadcast();

        console.log("GuardianVault:", address(vault));
        console.log("owner:", owner);
    }
}
