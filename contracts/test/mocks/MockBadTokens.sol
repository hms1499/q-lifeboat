// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// USDT-style token: transfer/transferFrom succeed but return no data.
contract NoReturnToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external {
        allowance[msg.sender][spender] = amount;
    }

    function transfer(address to, uint256 amount) external {
        _move(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) external {
        allowance[from][msg.sender] -= amount;
        _move(from, to, amount);
    }

    function _move(address from, address to, uint256 amount) internal {
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

/// Token that reports a fixed balance and allowance, and whose transfers return `ret` as raw bytes.
/// Used for false-return and malformed-return cases on both `rescue` and `withdraw`.
contract RawReturnToken {
    bytes public ret;

    constructor(bytes memory ret_) {
        ret = ret_;
    }

    function balanceOf(address) external pure returns (uint256) {
        return 100e18;
    }

    function allowance(address, address) external pure returns (uint256) {
        return type(uint256).max;
    }

    fallback() external {
        bytes memory r = ret;
        assembly {
            return(add(r, 0x20), mload(r))
        }
    }
}
