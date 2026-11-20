// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// Test double for the QoreChain PQC precompiles (0x...0a01 verify, 0x...0a02 key status).
/// Etched at both addresses; state is set through the setters because etched code has empty storage.
contract MockPqc {
    bool public registered;
    bool public proven;
    bytes public key;

    function setRegistered(bool v) external {
        registered = v;
    }

    function setProven(bool v) external {
        proven = v;
    }

    function setKey(bytes calldata k) external {
        key = k;
    }

    /// The signature this mock accepts for (pubkey, message).
    function expectedSig(bytes memory pubkey, bytes memory message) public pure returns (bytes memory) {
        return abi.encodePacked(keccak256(abi.encodePacked("ok", pubkey, message)));
    }

    function pqcKeyStatus(address)
        external
        view
        returns (bool, uint8, bytes memory, bool)
    {
        return (registered, 1, registered ? key : bytes(""), proven);
    }

    function pqcVerify(bytes calldata pubkey, bytes calldata sig, bytes calldata message)
        external
        pure
        returns (bool)
    {
        return keccak256(sig) == keccak256(expectedSig(pubkey, message));
    }
}
