// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {GuardianVault} from "../src/GuardianVault.sol";
import {Deploy} from "../script/Deploy.s.sol";

contract DeployTest is Test {
    string internal constant MNEMONIC =
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    function test_deploysVaultOwnedByDerivedKey() public {
        vm.chainId(9800);
        // forge-lint: disable-next-line(unsafe-cheatcode)
        vm.setEnv("OWNER_MNEMONIC", MNEMONIC);
        GuardianVault vault = new Deploy().run();
        assertEq(vault.owner(), 0x9858EfFD232B4033E47d90003D41EC34EcaEda94);
    }

    function test_revertsOnOtherChain() public {
        vm.chainId(1);
        // forge-lint: disable-next-line(unsafe-cheatcode)
        vm.setEnv("OWNER_MNEMONIC", MNEMONIC);
        Deploy d = new Deploy();
        vm.expectRevert("Deploy: diana (9800) only");
        d.run();
    }
}
