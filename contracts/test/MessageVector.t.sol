// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {GuardianVault} from "../src/GuardianVault.sol";

/// Shared TS <-> Solidity test vector. packages/core/test/vaultMessage.test.ts asserts the same hash.
contract MessageVectorTest is Test {
    address internal constant VAULT = 0x1111111111111111111111111111111111111111;
    address internal constant TO = 0x2222222222222222222222222222222222222222;
    address internal constant TOKEN = 0x3333333333333333333333333333333333333333;
    bytes32 internal constant EXPECTED = 0x783fcbffbc8f1ec81272b39002a0c603c86984c6f9138f874c950e790e3c31eb;

    function test_vectorHashAndLength() public {
        vm.chainId(9800);
        deployCodeTo("GuardianVault.sol:GuardianVault", abi.encode(address(0xBEEF)), VAULT);

        bytes memory m = GuardianVault(VAULT).withdrawalMessage(TO, TOKEN, 1e18, 0);
        assertEq(m.length, 172);
        assertEq(keccak256(m), EXPECTED);
    }
}
