// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {TestToken} from "../src/TestToken.sol";

/// Deploys the three faucet tokens (fUSD, fETH, fBTC) and mints 100 of each to the owner derived from
/// OWNER_MNEMONIC at m/44'/60'/0'/0/0. Testnet only.
contract DeployTokens is Script {
    uint256 internal constant MINT = 100e18;

    function run() external returns (TestToken usd, TestToken eth, TestToken btc) {
        require(block.chainid == 9800, "DeployTokens: diana (9800) only");
        // forge-lint: disable-next-line(unsafe-cheatcode)
        uint256 pk = vm.deriveKey(vm.envString("OWNER_MNEMONIC"), 0);
        address owner = vm.addr(pk);

        vm.startBroadcast(pk);
        usd = new TestToken("Faucet USD", "fUSD");
        eth = new TestToken("Faucet ETH", "fETH");
        btc = new TestToken("Faucet BTC", "fBTC");
        usd.mint(owner, MINT);
        eth.mint(owner, MINT);
        btc.mint(owner, MINT);
        vm.stopBroadcast();

        console.log("FUSD_ADDRESS:", address(usd));
        console.log("FETH_ADDRESS:", address(eth));
        console.log("FBTC_ADDRESS:", address(btc));
        console.log("owner:", owner);
    }
}
