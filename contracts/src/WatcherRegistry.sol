// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title WatcherRegistry
 * @notice Shared oracle module of the Zeus Trust Operating Layer.
 *         Product contracts (StakingInsurance, future Insurance V3) query
 *         confirmed events here instead of embedding oracle logic.
 *
 * @dev Watchers vote on product-defined eventIds. When `quorum` votes
 *      accumulate for one status, the event is resolved and readable.
 */
contract WatcherRegistry is Ownable {
    // ── Errors ────────────────────────────────────────────────────────────────
    error ZeroAddress();
    error AlreadyWatcher();
    error NotWatcher();
    error AlreadyVoted();
    error AlreadyResolved();
    error InvalidQuorum();

    // ── Events ────────────────────────────────────────────────────────────────
    event WatcherAdded(address indexed watcher);
    event WatcherRemoved(address indexed watcher);
    event ObservationCast(bytes32 indexed eventId, address indexed watcher, uint8 status);
    event EventResolved(bytes32 indexed eventId, uint8 decision);
    event QuorumUpdated(uint256 quorum);

    // ── State ─────────────────────────────────────────────────────────────────
    address[] public watcherList;
    mapping(address => bool) public isWatcher;

    mapping(bytes32 => mapping(address => bool)) public hasVoted;
    mapping(bytes32 => mapping(uint8 => uint256)) public voteCount;
    mapping(bytes32 => bool) public resolved;
    mapping(bytes32 => uint8) public decision;

    uint256 public quorum;

    constructor(uint256 _quorum) Ownable(msg.sender) {
        if (_quorum < 1) revert InvalidQuorum();
        quorum = _quorum;
    }

    // ── Watcher management (swap-and-pop) ─────────────────────────────────────
    function addWatcher(address watcher) external onlyOwner {
        if (watcher == address(0)) revert ZeroAddress();
        if (isWatcher[watcher]) revert AlreadyWatcher();
        isWatcher[watcher] = true;
        watcherList.push(watcher);
        emit WatcherAdded(watcher);
    }

    function removeWatcher(address watcher) external onlyOwner {
        if (!isWatcher[watcher]) revert NotWatcher();
        isWatcher[watcher] = false;
        uint256 len = watcherList.length;
        for (uint256 i = 0; i < len; i++) {
            if (watcherList[i] == watcher) {
                watcherList[i] = watcherList[len - 1];
                watcherList.pop();
                break;
            }
        }
        emit WatcherRemoved(watcher);
    }

    function getWatchers() external view returns (address[] memory) {
        return watcherList;
    }

    function setQuorum(uint256 _quorum) external onlyOwner {
        if (_quorum < 1) revert InvalidQuorum();
        quorum = _quorum;
        emit QuorumUpdated(_quorum);
    }

    // ── Observations ──────────────────────────────────────────────────────────
    /// @param eventId product-defined, e.g. keccak256(abi.encode(positionId))
    /// @param status  1 = event happened (slashing), 0 = refuted
    function submitObservation(bytes32 eventId, uint8 status) external {
        if (!isWatcher[msg.sender]) revert NotWatcher();
        if (hasVoted[eventId][msg.sender]) revert AlreadyVoted();
        if (resolved[eventId]) revert AlreadyResolved();

        hasVoted[eventId][msg.sender] = true;
        voteCount[eventId][status] += 1;
        emit ObservationCast(eventId, msg.sender, status);

        if (voteCount[eventId][status] >= quorum) {
            resolved[eventId] = true;
            decision[eventId] = status;
            emit EventResolved(eventId, status);
        }
    }

    // ── Views for consumer contracts ──────────────────────────────────────────
    function isConfirmed(bytes32 eventId, uint8 status) external view returns (bool) {
        return resolved[eventId] && decision[eventId] == status;
    }
}
