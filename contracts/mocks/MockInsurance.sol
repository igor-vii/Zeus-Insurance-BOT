// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

contract MockInsurance {
    mapping(uint256 => bool) public fulfilled;
    bool public approveAll;

    constructor(bool _approveAll) {
        approveAll = _approveAll;
    }

    function isClaimApproved(
        uint256 claimId,
        address,
        uint256
    ) external view returns (bool) {
        return approveAll;
    }

    function markClaimFulfilled(uint256 claimId) external {
        fulfilled[claimId] = true;
    }

    function hasPendingClaims() external pure returns (bool) {
        return false;
    }
}
