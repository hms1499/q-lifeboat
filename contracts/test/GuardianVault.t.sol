// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {GuardianVault} from "../src/GuardianVault.sol";
import {MockPqc} from "./mocks/MockPqc.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// Recipient whose receive() records the vault nonce it observes mid-withdrawal.
contract NonceProbe {
    GuardianVault public immutable vault;
    uint256 public seen = type(uint256).max;

    constructor(GuardianVault v) {
        vault = v;
    }

    receive() external payable {
        seen = vault.nonce();
    }
}

contract GuardianVaultTest is Test {
    address constant PQC_VERIFY = 0x0000000000000000000000000000000000000a01;
    address constant PQC_KEYS = 0x0000000000000000000000000000000000000a02;

    GuardianVault vault;
    MockERC20 token;
    MockERC20 other;
    MockPqc pqc = MockPqc(PQC_VERIFY);

    address owner = makeAddr("owner");
    address recipient = makeAddr("recipient");
    address stranger = makeAddr("stranger");
    bytes pubkey = hex"c0ffee";

    function setUp() public {
        MockPqc impl = new MockPqc();
        vm.etch(PQC_VERIFY, address(impl).code);
        vm.etch(PQC_KEYS, address(impl).code);
        // Both addresses are separate storage, so configure each one.
        MockPqc(PQC_VERIFY).setRegistered(true);
        MockPqc(PQC_VERIFY).setProven(true);
        MockPqc(PQC_VERIFY).setKey(pubkey);
        MockPqc(PQC_KEYS).setRegistered(true);
        MockPqc(PQC_KEYS).setProven(true);
        MockPqc(PQC_KEYS).setKey(pubkey);

        vault = new GuardianVault(owner);
        token = new MockERC20();
        other = new MockERC20();
    }

    function _sig(address to, address tok, uint256 amount, uint256 n) internal view returns (bytes memory) {
        return pqc.expectedSig(pubkey, vault.withdrawalMessage(to, tok, amount, n));
    }

    function _fundQor(uint256 amount) internal {
        vm.deal(address(this), amount);
        vault.deposit{value: amount}();
    }

    // ---- rescue ----

    function test_rescuePullsAllowedBalance() public {
        token.mint(owner, 100e18);
        vm.prank(owner);
        token.approve(address(vault), type(uint256).max);

        vault.rescue(address(token));

        assertEq(token.balanceOf(address(vault)), 100e18);
        assertEq(token.balanceOf(owner), 0);
    }

    function test_rescueZeroBalanceDoesNotRevert() public {
        vm.expectEmit(true, false, false, true);
        emit GuardianVault.Rescued(address(token), 0);
        vault.rescue(address(token));
        assertEq(token.balanceOf(address(vault)), 0);
    }

    function test_rescueCapsAtAllowance() public {
        token.mint(owner, 100e18);
        vm.prank(owner);
        token.approve(address(vault), 40e18);

        vault.rescue(address(token));

        assertEq(token.balanceOf(address(vault)), 40e18);
        assertEq(token.balanceOf(owner), 60e18);
    }

    function test_rescueCallableByAnyone() public {
        token.mint(owner, 100e18);
        token.mint(stranger, 7e18);
        vm.prank(owner);
        token.approve(address(vault), type(uint256).max);

        vm.prank(stranger);
        vault.rescue(address(token));

        assertEq(token.balanceOf(stranger), 7e18, "caller untouched");
        assertEq(token.balanceOf(owner), 0);
        assertEq(token.balanceOf(address(vault)), 100e18);
        assertEq(token.balanceOf(recipient), 0);
    }

    // ---- deposit ----

    function test_depositEmits() public {
        vm.deal(address(this), 3 ether);
        vm.expectEmit(false, false, false, true);
        emit GuardianVault.Deposited(3 ether);
        vault.deposit{value: 3 ether}();
        assertEq(address(vault).balance, 3 ether);
    }

    // ---- withdraw ----

    function test_withdrawWithValidSig() public {
        _fundQor(5 ether);
        bytes memory sig = _sig(recipient, address(0), 2 ether, 0);

        vm.expectEmit(true, true, false, true);
        emit GuardianVault.Withdrawn(recipient, address(0), 2 ether, 0);
        vault.withdraw(recipient, address(0), 2 ether, sig);

        assertEq(recipient.balance, 2 ether);
        assertEq(address(vault).balance, 3 ether);
        assertEq(vault.nonce(), 1);
    }

    function test_withdrawErc20() public {
        token.mint(address(vault), 50e18);
        bytes memory sig = _sig(recipient, address(token), 20e18, 0);

        vault.withdraw(recipient, address(token), 20e18, sig);

        assertEq(token.balanceOf(recipient), 20e18);
        assertEq(token.balanceOf(address(vault)), 30e18);
        assertEq(vault.nonce(), 1);
    }

    function test_revertsBadSignature() public {
        _fundQor(1 ether);
        bytes memory bad = hex"deadbeef";
        vm.expectRevert(GuardianVault.BadSignature.selector);
        vault.withdraw(recipient, address(0), 1 ether, bad);
        assertEq(vault.nonce(), 0);
    }

    function test_signatureWorksOnce() public {
        _fundQor(5 ether);
        bytes memory sig = _sig(recipient, address(0), 1 ether, 0);
        vault.withdraw(recipient, address(0), 1 ether, sig);

        vm.expectRevert(GuardianVault.BadSignature.selector);
        vault.withdraw(recipient, address(0), 1 ether, sig);
        assertEq(recipient.balance, 1 ether);
    }

    function test_revertsWhenKeyNotRegistered() public {
        _fundQor(1 ether);
        bytes memory sig = _sig(recipient, address(0), 1 ether, 0);
        MockPqc(PQC_KEYS).setRegistered(false);

        vm.expectRevert(GuardianVault.KeyNotRegistered.selector);
        vault.withdraw(recipient, address(0), 1 ether, sig);
    }

    function test_revertsWhenKeyNotProven() public {
        _fundQor(1 ether);
        bytes memory sig = _sig(recipient, address(0), 1 ether, 0);
        MockPqc(PQC_KEYS).setProven(false);

        vm.expectRevert(GuardianVault.KeyNotProven.selector);
        vault.withdraw(recipient, address(0), 1 ether, sig);
    }

    function test_signatureBoundToToAmountToken() public {
        _fundQor(5 ether);
        token.mint(address(vault), 5e18);
        other.mint(address(vault), 5e18);
        bytes memory sig = _sig(recipient, address(token), 1e18, 0);

        vm.expectRevert(GuardianVault.BadSignature.selector);
        vault.withdraw(stranger, address(token), 1e18, sig); // different to

        vm.expectRevert(GuardianVault.BadSignature.selector);
        vault.withdraw(recipient, address(token), 2e18, sig); // different amount

        vm.expectRevert(GuardianVault.BadSignature.selector);
        vault.withdraw(recipient, address(other), 1e18, sig); // different token

        // The untouched signature still works.
        vault.withdraw(recipient, address(token), 1e18, sig);
        assertEq(token.balanceOf(recipient), 1e18);
    }

    function test_nonceIncrementsBeforeTransfer() public {
        _fundQor(2 ether);
        NonceProbe probe = new NonceProbe(vault);
        bytes memory sig = _sig(address(probe), address(0), 1 ether, 0);

        vault.withdraw(address(probe), address(0), 1 ether, sig);

        assertEq(probe.seen(), 1, "nonce already bumped when funds arrive");
        assertEq(address(probe).balance, 1 ether);
    }
}
