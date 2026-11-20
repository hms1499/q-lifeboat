// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {GuardianVault} from "../src/GuardianVault.sol";
import {Deploy} from "../script/Deploy.s.sol";

/// vm.setEnv is process-wide and forge runs tests in parallel, so every test that sets the
/// environment sets the SAME values. The guardian checks go through `deploy(pk, guardian)`.
contract DeployTest is Test {
    string internal constant MNEMONIC =
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    address internal constant DERIVED_OWNER = 0x9858EfFD232B4033E47d90003D41EC34EcaEda94;
    address internal constant GUARDIAN = address(0xC0DE5);

    function _env() internal {
        // forge-lint: disable-next-line(unsafe-cheatcode)
        vm.setEnv("OWNER_MNEMONIC", MNEMONIC);
        // forge-lint: disable-next-line(unsafe-cheatcode)
        vm.setEnv("GUARDIAN_ADDRESS", vm.toString(GUARDIAN));
    }

    function _pk() internal pure returns (uint256) {
        // forge-lint: disable-next-line(unsafe-cheatcode)
        return vm.deriveKey(MNEMONIC, 0);
    }

    function test_deploysVaultOwnedByDerivedKeyWithGuardian() public {
        vm.chainId(9800);
        _env();
        GuardianVault vault = new Deploy().run();
        assertEq(vault.owner(), DERIVED_OWNER);
        assertEq(vault.guardian(), GUARDIAN);
    }

    function test_revertsOnOtherChain() public {
        vm.chainId(1);
        _env();
        Deploy d = new Deploy();
        vm.expectRevert("Deploy: diana (9800) only");
        d.run();
        uint256 pk = _pk();
        vm.expectRevert("Deploy: diana (9800) only");
        d.deploy(pk, GUARDIAN);
    }

    function test_revertsOnZeroGuardian() public {
        vm.chainId(9800);
        Deploy d = new Deploy();
        uint256 pk = _pk();
        vm.expectRevert("Deploy: GUARDIAN_ADDRESS is zero");
        d.deploy(pk, address(0));
    }

    function test_revertsWhenGuardianIsOwner() public {
        vm.chainId(9800);
        Deploy d = new Deploy();
        uint256 pk = _pk();
        vm.expectRevert("Deploy: GUARDIAN_ADDRESS is the owner");
        d.deploy(pk, DERIVED_OWNER);
    }
}
