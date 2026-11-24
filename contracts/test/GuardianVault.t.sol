// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {GuardianVault} from "../src/GuardianVault.sol";
import {MockPqc} from "./mocks/MockPqc.sol";
import {MockERC20, FalseToken} from "./mocks/MockERC20.sol";
import {NoReturnToken, RawReturnToken} from "./mocks/MockBadTokens.sol";

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

/// Recipient that rejects QOR.
contract Rejecter {
    receive() external payable {
        revert("no");
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
    address guardian = makeAddr("guardian");
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

        vault = new GuardianVault(owner, guardian);
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

        vm.prank(owner);
        vault.rescue(address(token));

        assertEq(token.balanceOf(address(vault)), 100e18);
        assertEq(token.balanceOf(owner), 0);
    }

    function test_rescueZeroBalanceDoesNotRevert() public {
        vm.expectEmit(true, false, false, true);
        emit GuardianVault.Rescued(address(token), 0);
        vm.prank(owner);
        vault.rescue(address(token));
        assertEq(token.balanceOf(address(vault)), 0);
    }

    function test_rescueCapsAtAllowance() public {
        token.mint(owner, 100e18);
        vm.prank(owner);
        token.approve(address(vault), 40e18);

        vm.prank(owner);
        vault.rescue(address(token));

        assertEq(token.balanceOf(address(vault)), 40e18);
        assertEq(token.balanceOf(owner), 60e18);
    }

    function test_guardianCanRescue() public {
        token.mint(owner, 100e18);
        token.mint(guardian, 5e18);
        vm.prank(owner);
        token.approve(address(vault), type(uint256).max);

        vm.expectEmit(true, false, false, true);
        emit GuardianVault.Rescued(address(token), 100e18);
        vm.prank(guardian);
        vault.rescue(address(token));

        assertEq(token.balanceOf(address(vault)), 100e18, "owner -> vault");
        assertEq(token.balanceOf(owner), 0);
        assertEq(token.balanceOf(guardian), 5e18, "guardian gains nothing");
    }

    function test_guardianGetterReturnsConstructorValue() public view {
        assertEq(vault.guardian(), guardian);
        assertEq(vault.owner(), owner);
    }

    function test_guardianCannotWithdrawWithoutSignature() public {
        _fundQor(2 ether);
        token.mint(address(vault), 10e18);

        vm.startPrank(guardian);
        vm.expectRevert(GuardianVault.BadSignature.selector);
        vault.withdraw(guardian, address(0), 1 ether, hex"deadbeef");
        vm.expectRevert(GuardianVault.BadSignature.selector);
        vault.withdraw(guardian, address(token), 10e18, hex"deadbeef");
        vm.stopPrank();

        assertEq(address(vault).balance, 2 ether);
        assertEq(token.balanceOf(address(vault)), 10e18);
        assertEq(vault.nonce(), 0);
    }

    function test_rescueRevertsForStranger() public {
        token.mint(owner, 100e18);
        token.mint(stranger, 7e18);
        vm.prank(owner);
        token.approve(address(vault), type(uint256).max);

        vm.prank(stranger);
        vm.expectRevert(GuardianVault.NotAuthorized.selector);
        vault.rescue(address(token));

        assertEq(token.balanceOf(stranger), 7e18, "caller untouched");
        assertEq(token.balanceOf(owner), 100e18, "owner untouched");
        assertEq(token.balanceOf(address(vault)), 0);
    }

    // ---- deposit ----

    function test_depositEmits() public {
        vm.deal(address(this), 3 ether);
        vm.expectEmit(false, false, false, true);
        emit GuardianVault.Deposited(3 ether);
        vault.deposit{value: 3 ether}();
        assertEq(address(vault).balance, 3 ether);
    }

    /// QCAI Stage 2 #1: `deposit` is open by design. A stranger's deposit only adds to the owner's vault: the stranger
    /// can not take it back, only the owner's ML-DSA-87 signature moves it out.
    function test_strangerDepositOnlyAddsToTheOwnersVault() public {
        vm.deal(stranger, 2 ether);
        vm.prank(stranger);
        vault.deposit{value: 2 ether}();
        assertEq(address(vault).balance, 2 ether);

        bytes memory forged = hex"deadbeef";
        vm.prank(stranger);
        vm.expectRevert(GuardianVault.BadSignature.selector);
        vault.withdraw(stranger, address(0), 2 ether, forged);

        vault.withdraw(recipient, address(0), 2 ether, _sig(recipient, address(0), 2 ether, 0));
        assertEq(recipient.balance, 2 ether);
        assertEq(stranger.balance, 0);
    }

    /// QCAI Stage 2 #2: a front-runner who copies the owner's signed withdrawal from the mempool can only submit that
    /// same withdrawal. The funds go to the signed `to`, never to the submitter, and the owner's own tx then reverts.
    function test_frontRunnerCanOnlyPayTheSignedRecipient() public {
        _fundQor(5 ether);
        bytes memory sig = _sig(recipient, address(0), 2 ether, 0);

        vm.prank(stranger);
        vm.expectRevert(GuardianVault.BadSignature.selector);
        vault.withdraw(stranger, address(0), 2 ether, sig); // redirecting the payout breaks the signature

        vm.prank(stranger);
        vault.withdraw(recipient, address(0), 2 ether, sig); // submitting it as signed pays the owner's recipient
        assertEq(recipient.balance, 2 ether);
        assertEq(stranger.balance, 0);

        vm.expectRevert(GuardianVault.BadSignature.selector);
        vault.withdraw(recipient, address(0), 2 ether, sig); // the owner's copy: nonce used, nothing paid twice
        assertEq(recipient.balance, 2 ether);
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

    // ---- binding ----

    function test_signatureBoundToVault() public {
        _fundQor(2 ether);
        GuardianVault vaultB = new GuardianVault(owner, guardian);
        vm.deal(address(vaultB), 2 ether);
        bytes memory sigA = _sig(recipient, address(0), 1 ether, 0);

        vm.expectRevert(GuardianVault.BadSignature.selector);
        vaultB.withdraw(recipient, address(0), 1 ether, sigA);
    }

    function test_signatureBoundToChainId() public {
        _fundQor(2 ether);
        bytes memory sig = _sig(recipient, address(0), 1 ether, 0);
        vm.chainId(9800);

        vm.expectRevert(GuardianVault.BadSignature.selector);
        vault.withdraw(recipient, address(0), 1 ether, sig);
    }

    function test_withdrawalMessageLayout() public view {
        bytes memory expected = abi.encodePacked(
            "QDAY-GUARDIAN-V1", block.chainid, address(vault), recipient, address(token), uint256(5), uint256(3)
        );
        bytes memory got = vault.withdrawalMessage(recipient, address(token), 5, 3);
        assertEq(got, expected);
        assertEq(got.length, 172);
    }

    // ---- failure paths ----

    function test_withdrawToCodelessTokenReverts() public {
        address codeless = makeAddr("codeless");
        bytes memory sig = _sig(recipient, codeless, 1e18, 0);

        vm.expectRevert(GuardianVault.TransferFailed.selector);
        vault.withdraw(recipient, codeless, 1e18, sig);
    }

    function test_withdrawRevertsWhenRecipientRejects() public {
        _fundQor(2 ether);
        address rej = address(new Rejecter());
        bytes memory sig = _sig(rej, address(0), 1 ether, 0);

        vm.expectRevert(GuardianVault.TransferFailed.selector);
        vault.withdraw(rej, address(0), 1 ether, sig);
    }

    function test_withdrawRevertsWhenTokenReturnsFalse() public {
        FalseToken bad = new FalseToken();
        bytes memory sig = _sig(recipient, address(bad), 1e18, 0);

        vm.expectRevert(GuardianVault.TransferFailed.selector);
        vault.withdraw(recipient, address(bad), 1e18, sig);
    }

    function test_rescueWithBalanceButNoAllowance() public {
        token.mint(owner, 100e18);

        vm.prank(owner);
        vault.rescue(address(token));

        assertEq(token.balanceOf(address(vault)), 0);
        assertEq(token.balanceOf(owner), 100e18);
    }

    function test_constructorRejectsZeroOwner() public {
        vm.expectRevert(GuardianVault.ZeroOwner.selector);
        new GuardianVault(address(0), guardian);
    }

    function test_constructorRejectsZeroGuardian() public {
        vm.expectRevert(GuardianVault.ZeroGuardian.selector);
        new GuardianVault(owner, address(0));
    }

    // ---- token return-value semantics ----

    function test_noReturnTokenWorksForRescueAndWithdraw() public {
        NoReturnToken usdt = new NoReturnToken();
        usdt.mint(owner, 100e18);
        vm.prank(owner);
        usdt.approve(address(vault), type(uint256).max);

        vm.prank(owner);
        vault.rescue(address(usdt));
        assertEq(usdt.balanceOf(address(vault)), 100e18);
        assertEq(usdt.balanceOf(owner), 0);

        bytes memory sig = _sig(recipient, address(usdt), 40e18, 0);
        vault.withdraw(recipient, address(usdt), 40e18, sig);
        assertEq(usdt.balanceOf(recipient), 40e18);
        assertEq(usdt.balanceOf(address(vault)), 60e18);
    }

    function _badReturns() internal returns (RawReturnToken[3] memory t) {
        t[0] = new RawReturnToken(abi.encode(false)); // returns false
        t[1] = new RawReturnToken(hex"01"); // 1-byte return
        t[2] = new RawReturnToken(abi.encode(uint256(2))); // word 2, not a bool
    }

    function test_badReturnTokensRevertTransferFailedOnRescue() public {
        RawReturnToken[3] memory bad = _badReturns();
        for (uint256 i; i < bad.length; ++i) {
            vm.prank(owner);
            vm.expectRevert(GuardianVault.TransferFailed.selector);
            vault.rescue(address(bad[i]));
        }
    }

    function test_badReturnTokensRevertTransferFailedOnWithdraw() public {
        RawReturnToken[3] memory bad = _badReturns();
        for (uint256 i; i < bad.length; ++i) {
            bytes memory sig = _sig(recipient, address(bad[i]), 1e18, 0);
            vm.expectRevert(GuardianVault.TransferFailed.selector);
            vault.withdraw(recipient, address(bad[i]), 1e18, sig);
        }
    }
}
