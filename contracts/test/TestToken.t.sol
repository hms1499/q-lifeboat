// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {GuardianVault} from "../src/GuardianVault.sol";
import {TestToken} from "../src/TestToken.sol";
import {MockPqc} from "./mocks/MockPqc.sol";

contract TestTokenTest is Test {
    address constant PQC_VERIFY = 0x0000000000000000000000000000000000000a01;
    address constant PQC_KEYS = 0x0000000000000000000000000000000000000a02;

    TestToken token;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");

    function setUp() public {
        token = new TestToken("Faucet USD", "fUSD");
    }

    function test_metadata() public view {
        assertEq(token.name(), "Faucet USD");
        assertEq(token.symbol(), "fUSD");
        assertEq(token.decimals(), 18);
    }

    function test_mintIsPublic() public {
        vm.prank(carol);
        token.mint(alice, 5e18);
        assertEq(token.balanceOf(alice), 5e18);
        assertEq(token.totalSupply(), 5e18);
    }

    function test_mintEmitsTransferFromZero() public {
        vm.expectEmit(true, true, false, true);
        emit TestToken.Transfer(address(0), alice, 1e18);
        token.mint(alice, 1e18);
    }

    function test_transfer() public {
        token.mint(alice, 10e18);
        vm.prank(alice);
        assertTrue(token.transfer(bob, 4e18));
        assertEq(token.balanceOf(alice), 6e18);
        assertEq(token.balanceOf(bob), 4e18);
    }

    function test_transferRevertsOnInsufficientBalance() public {
        token.mint(alice, 1e18);
        vm.prank(alice);
        vm.expectRevert("TestToken: balance");
        token.transfer(bob, 2e18);
    }

    function test_approveAndTransferFrom() public {
        token.mint(alice, 10e18);
        vm.prank(alice);
        token.approve(bob, 6e18);
        assertEq(token.allowance(alice, bob), 6e18);

        vm.prank(bob);
        assertTrue(token.transferFrom(alice, carol, 4e18));
        assertEq(token.balanceOf(carol), 4e18);
        assertEq(token.allowance(alice, bob), 2e18);
    }

    function test_transferFromRevertsOnInsufficientAllowance() public {
        token.mint(alice, 10e18);
        vm.prank(alice);
        token.approve(bob, 1e18);
        vm.prank(bob);
        vm.expectRevert("TestToken: allowance");
        token.transferFrom(alice, carol, 2e18);
    }

    function test_transferFromRevertsOnInsufficientBalance() public {
        token.mint(alice, 1e18);
        vm.prank(alice);
        token.approve(bob, 5e18);
        vm.prank(bob);
        vm.expectRevert("TestToken: balance");
        token.transferFrom(alice, carol, 2e18);
    }

    function test_maxAllowanceIsNotDecremented() public {
        token.mint(alice, 10e18);
        vm.prank(alice);
        token.approve(bob, type(uint256).max);
        vm.prank(bob);
        token.transferFrom(alice, carol, 3e18);
        assertEq(token.allowance(alice, bob), type(uint256).max);
    }

    /// The guardian's rescue pulls the owner's balance into the vault; withdraw then pays it out under a (mock) ML-DSA signature.
    function test_rescueThenWithdrawRoundTrip() public {
        bytes memory pubkey = hex"c0ffee";
        MockPqc impl = new MockPqc();
        vm.etch(PQC_VERIFY, address(impl).code);
        vm.etch(PQC_KEYS, address(impl).code);
        MockPqc(PQC_VERIFY).setRegistered(true);
        MockPqc(PQC_VERIFY).setProven(true);
        MockPqc(PQC_VERIFY).setKey(pubkey);
        MockPqc(PQC_KEYS).setRegistered(true);
        MockPqc(PQC_KEYS).setProven(true);
        MockPqc(PQC_KEYS).setKey(pubkey);

        address guardian = makeAddr("guardian");
        GuardianVault vault = new GuardianVault(alice, guardian);
        token.mint(alice, 100e18);
        vm.prank(alice);
        token.approve(address(vault), type(uint256).max);

        vm.prank(guardian);
        vault.rescue(address(token));
        assertEq(token.balanceOf(address(vault)), 100e18);
        assertEq(token.balanceOf(alice), 0);

        bytes memory sig =
            MockPqc(PQC_VERIFY).expectedSig(pubkey, vault.withdrawalMessage(bob, address(token), 1e18, 0));
        vault.withdraw(bob, address(token), 1e18, sig);
        assertEq(token.balanceOf(bob), 1e18);
        assertEq(token.balanceOf(address(vault)), 99e18);
        assertEq(vault.nonce(), 1);
    }
}
