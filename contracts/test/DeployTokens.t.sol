// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {TestToken} from "../src/TestToken.sol";
import {DeployTokens} from "../script/DeployTokens.s.sol";

contract DeployTokensTest is Test {
    string internal constant MNEMONIC =
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    address internal constant OWNER = 0x9858EfFD232B4033E47d90003D41EC34EcaEda94;

    function test_deploysThreeTokensAndMintsToOwner() public {
        vm.chainId(9800);
        // forge-lint: disable-next-line(unsafe-cheatcode)
        vm.setEnv("OWNER_MNEMONIC", MNEMONIC);
        (TestToken usd, TestToken eth, TestToken btc) = new DeployTokens().run();
        assertEq(usd.symbol(), "fUSD");
        assertEq(eth.symbol(), "fETH");
        assertEq(btc.symbol(), "fBTC");
        assertEq(usd.balanceOf(OWNER), 100e18);
        assertEq(eth.balanceOf(OWNER), 100e18);
        assertEq(btc.balanceOf(OWNER), 100e18);
    }

    function test_revertsOnOtherChain() public {
        vm.chainId(1);
        // forge-lint: disable-next-line(unsafe-cheatcode)
        vm.setEnv("OWNER_MNEMONIC", MNEMONIC);
        DeployTokens d = new DeployTokens();
        vm.expectRevert("DeployTokens: diana (9800) only");
        d.run();
    }
}
