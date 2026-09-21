// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract OwnableTest is Ownable {
    constructor() Ownable(msg.sender) {}
}

contract SanityTest is Test {
    function test_toolchain_compiles_openzeppelin() public pure {
        assertTrue(type(OwnableTest).creationCode.length > 0);
    }
}
