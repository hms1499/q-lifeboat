// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {GuardianVault} from "../src/GuardianVault.sol";
import {Deploy} from "../script/Deploy.s.sol";

contract DeployTest is Test {
    function test_deploysVaultOwnedByDerivedKey() public {
        vm.setEnv("OWNER_MNEMONIC", "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about");
        GuardianVault vault = new Deploy().run();
        assertEq(vault.owner(), 0x9858EfFD232B4033E47d90003D41EC34EcaEda94);
    }
}
