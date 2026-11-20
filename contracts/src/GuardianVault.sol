// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// QoreChain precompiles (active on the qorechain-diana testnet).
interface IQorePQC {
    /// ML-DSA-87 (FIPS 204) verification.
    function pqcVerify(bytes calldata pubkey, bytes calldata signature, bytes calldata message)
        external view returns (bool valid);

    /// The ML-DSA-87 key an account registered on chain.
    function pqcKeyStatus(address account)
        external view returns (bool registered, uint8 algorithmId, bytes memory pubkey, bool possessionProven);
}

/// @title GuardianVault
/// @notice Q-Day Guardian vault. The Guardian agent calls `rescue` to pull an account's ERC20
/// balance (up to the allowance the owner granted) into this vault. Funds can only leave through
/// `withdraw`, which needs an ML-DSA-87 signature from the owner's registered post-quantum key.
/// A leaked ECDSA key alone cannot move anything out of the vault.
///
/// `rescue` may be called by the owner or by an immutable `guardian` (the agent's own EVM
/// account). The agent can no longer rescue through the QoreChain authenticator lane: on diana the
/// lane now refuses a token move from the account unless the token is listed in the key's spending
/// rule (tx 8508B568…), and listing it lets the key `transfer` the token directly (tx CADB1412…).
/// See docs/EVIDENCE.md "Task 4". The guardian has no other power: `rescue` only moves funds
/// owner -> vault, and `withdraw` still needs the owner's ML-DSA-87 signature.
///
/// Pattern adapted from qorechain/build-before-qday workshop-2 QDayVault.
contract GuardianVault {
    IQorePQC internal constant PQC_VERIFY = IQorePQC(0x0000000000000000000000000000000000000a01);
    IQorePQC internal constant PQC_KEYS = IQorePQC(0x0000000000000000000000000000000000000a02);

    /// The account whose registered ML-DSA-87 key authorises withdrawals. No setters.
    address public immutable owner;
    /// The Guardian agent's EVM account. It may call `rescue` and nothing else. No setters.
    address public immutable guardian;
    /// Increases with every withdrawal, so a signature works once.
    uint256 public nonce;

    event Deposited(uint256 amount);
    event Rescued(address indexed token, uint256 amount);
    event Withdrawn(address indexed to, address indexed token, uint256 amount, uint256 nonce);

    error KeyNotRegistered();
    error KeyNotProven();
    error BadSignature();
    error TransferFailed();
    error ZeroOwner();
    error ZeroGuardian();
    error NotAuthorized();

    constructor(address owner_, address guardian_) {
        if (owner_ == address(0)) revert ZeroOwner();
        if (guardian_ == address(0)) revert ZeroGuardian();
        owner = owner_;
        guardian = guardian_;
    }

    /// Fund the vault with QOR.
    function deposit() external payable {
        emit Deposited(msg.value);
    }

    /// Pull min(balance, allowance) of `token` from the owner into the vault.
    /// Owner or guardian only, so a third party can not sweep the owner's approved tokens
    /// (griefing) or emit `Rescued`. Funds only ever move owner -> vault, whoever calls.
    /// Never reverts on a zero amount.
    function rescue(address token) external {
        if (msg.sender != owner && msg.sender != guardian) revert NotAuthorized();
        uint256 balance = IERC20(token).balanceOf(owner);
        uint256 allowed = IERC20(token).allowance(owner, address(this));
        uint256 amount = balance < allowed ? balance : allowed;
        if (amount > 0) {
            _safeTransferFrom(token, owner, address(this), amount);
        }
        emit Rescued(token, amount);
    }

    /// The exact bytes the owner's ML-DSA key signs for a withdrawal. `token == address(0)` means QOR.
    function withdrawalMessage(address to, address token, uint256 amount, uint256 n)
        public view returns (bytes memory)
    {
        return abi.encodePacked("QDAY-GUARDIAN-V1", block.chainid, address(this), to, token, amount, n);
    }

    /// Anyone may submit; the ML-DSA-87 signature is what authorises.
    function withdraw(address to, address token, uint256 amount, bytes calldata mldsaSig) external {
        (bool registered,, bytes memory pubkey, bool proven) = PQC_KEYS.pqcKeyStatus(owner);
        if (!registered || pubkey.length == 0) revert KeyNotRegistered();
        if (!proven) revert KeyNotProven();

        uint256 n = nonce;
        if (!PQC_VERIFY.pqcVerify(pubkey, mldsaSig, withdrawalMessage(to, token, amount, n))) {
            revert BadSignature();
        }

        // Effects before any external call.
        nonce = n + 1;
        emit Withdrawn(to, token, amount, n);

        if (token == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            _safeTransfer(token, to, amount);
        }
    }

    /// SafeERC20 semantics: a call succeeded if it did not revert and either returned nothing
    /// from an address that has code (an EOA/empty address would "succeed" silently), or returned
    /// at least one word whose first word is exactly 1. Any other return data is a failure.
    function _succeeded(address token, bool ok, bytes memory ret) private view returns (bool) {
        if (!ok) return false;
        if (ret.length == 0) return token.code.length != 0;
        if (ret.length < 32) return false;
        return abi.decode(ret, (uint256)) == 1;
    }

    function _safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!_succeeded(token, ok, ret)) revert TransferFailed();
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20.transferFrom, (from, to, amount)));
        if (!_succeeded(token, ok, ret)) revert TransferFailed();
    }
}

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}
