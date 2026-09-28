// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "./interfaces/IInsuranceContract.sol";
import "./ZeusReserveV2.sol";

/**
 * @title ZeusInsuranceBaseV0
 * @notice Minimal insurance for AI agent execution failures on Base.
 * @dev V0: Simple economic core + rich observation layer (off-chain).
 */
contract ZeusInsuranceBaseV0 is IInsuranceContract, ReentrancyGuard, Ownable, Pausable {
    using SafeERC20 for IERC20;
    using ECDSA for bytes32;

    error InvalidSettlementTokenAddress();
    error InvalidReserveAddress();
    error ZeroAddress();
    error InvalidCounterparty();
    error InvalidAmount();
    error InvalidTimeout();
    error InvalidPremium();
    error PolicyDoesNotExist();
    error PolicyNotActive();
    error OnlyBuyerCanRequest();
    error DeadlineNotReached();
    error NotWatcher();
    error InvalidOutcome();
    error VoteAlreadyResolved();
    error WatcherAlreadyVoted();
    error RequestAlreadyExists();
    error InsufficientReserve();
    error CannotRenounceOwnership();

    enum PolicyStatus { Active, Completed, Payout, ManualReview }

    struct Policy {
        address buyer;
        address counterparty;
        uint256 amount;
        uint256 premium;
        uint256 deadline;
        PolicyStatus status;
        bytes32 operationId;
        bytes32 requestId;
    }

    struct Observation {
        bytes32 requestId;
        uint256 policyId;
        uint8 outcome;
        bytes32 evidenceHash;
        uint256 timestamp;
        bytes signature;
    }

    IERC20 public settlementToken;
    ZeusReserveV2 public reserve;

    mapping(uint256 => Policy) public policies;
    uint256 public nextPolicyId;
    uint256 public activePolicyCount;

    address[] public watcherList;
    mapping(address => bool) public isWatcher;
    mapping(bytes32 => uint8[]) public votes;
    mapping(bytes32 => bool) public resolved;
    mapping(bytes32 => mapping(address => bool)) public hasVoted;
    mapping(uint256 => bytes32) public policyToRequestId;

    uint256 public constant QUORUM = 2;

    event PolicyCreated(uint256 indexed policyId, address indexed buyer, address indexed counterparty, uint256 amount, bytes32 operationId);
    event ReviewRequested(uint256 indexed policyId, bytes32 indexed requestId);
    event ObservationSubmitted(bytes32 indexed requestId, address indexed watcher, uint8 outcome, bytes32 evidenceHash);
    event PolicyCompleted(uint256 indexed policyId);
    event PayoutAuthorized(uint256 indexed policyId, uint256 amount);
    event PayoutExecuted(uint256 indexed policyId, uint256 amount);
    event ManualReviewRequired(uint256 indexed policyId, string reason);
    event WatcherAdded(address indexed watcher);
    event WatcherRemoved(address indexed watcher);

    constructor(address _settlementToken, address _reserve) Ownable(msg.sender) {
        if (_settlementToken == address(0)) revert InvalidSettlementTokenAddress();
        if (_reserve == address(0)) revert InvalidReserveAddress();
        settlementToken = IERC20(_settlementToken);
        reserve = ZeusReserveV2(_reserve);
    }

    function renounceOwnership() public override onlyOwner {
        revert CannotRenounceOwnership();
    }

    function buyPolicy(address counterparty, uint256 amount, uint256 timeoutSeconds, uint256 premium, bytes32 operationId) external nonReentrant whenNotPaused returns (uint256) {
        if (counterparty == address(0)) revert InvalidCounterparty();
        if (amount == 0) revert InvalidAmount();
        if (timeoutSeconds == 0) revert InvalidTimeout();
        if (premium == 0 || premium > amount) revert InvalidPremium();
        settlementToken.safeTransferFrom(msg.sender, address(reserve), premium);
        uint256 policyId = nextPolicyId++;
        policies[policyId] = Policy({buyer: msg.sender, counterparty: counterparty, amount: amount, premium: premium, deadline: block.timestamp + timeoutSeconds, status: PolicyStatus.Active, operationId: operationId, requestId: bytes32(0)});
        activePolicyCount++;
        emit PolicyCreated(policyId, msg.sender, counterparty, amount, operationId);
        return policyId;
    }

    function requestReview(uint256 policyId) external whenNotPaused {
        Policy storage p = policies[policyId];
        if (p.buyer == address(0)) revert PolicyDoesNotExist();
        if (p.buyer != msg.sender) revert OnlyBuyerCanRequest();
        if (p.status != PolicyStatus.Active) revert PolicyNotActive();
        if (block.timestamp < p.deadline) revert DeadlineNotReached();
        if (p.requestId != bytes32(0)) revert RequestAlreadyExists();
        bytes32 requestId = keccak256(abi.encodePacked(p.buyer, p.counterparty, policyId, p.operationId, block.number));
        p.requestId = requestId;
        policyToRequestId[policyId] = requestId;
        emit ReviewRequested(policyId, requestId);
    }

    function submitObservation(Observation calldata obs) external whenNotPaused {
        if (!isWatcher[msg.sender]) revert NotWatcher();
        if (obs.outcome > 2) revert InvalidOutcome();
        Policy storage p = policies[obs.policyId];
        if (p.buyer == address(0)) revert PolicyDoesNotExist();
        if (p.status != PolicyStatus.Active) revert PolicyNotActive();
        if (resolved[obs.requestId]) revert VoteAlreadyResolved();
        if (hasVoted[obs.requestId][msg.sender]) revert WatcherAlreadyVoted();
        if (p.requestId != obs.requestId) revert InvalidOutcome();
        address signer = _verifyObservation(obs);
        if (signer != msg.sender) revert NotWatcher();
        hasVoted[obs.requestId][msg.sender] = true;
        votes[obs.requestId].push(obs.outcome);
        emit ObservationSubmitted(obs.requestId, msg.sender, obs.outcome, obs.evidenceHash);
        if (votes[obs.requestId].length >= QUORUM) {
            _resolveVote(obs.policyId, obs.requestId);
        }
    }

    function _verifyObservation(Observation calldata obs) internal pure returns (address) {
        bytes32 msgHash = keccak256(abi.encodePacked(obs.requestId, obs.policyId, obs.outcome, obs.evidenceHash, obs.timestamp));
        bytes32 ethHash = MessageHashUtils.toEthSignedMessageHash(msgHash);
        return ECDSA.recover(ethHash, obs.signature);
    }

    function _resolveVote(uint256 policyId, bytes32 requestId) internal {
        if (resolved[requestId]) return;
        resolved[requestId] = true;
        uint8[] memory outcomes = votes[requestId];
        uint256 success = 0;
        uint256 failure = 0;
        for (uint i = 0; i < outcomes.length; i++) {
            if (outcomes[i] == 0) success++;
            else if (outcomes[i] == 1) failure++;
        }
        Policy storage p = policies[policyId];
        if (failure >= QUORUM) {
            p.status = PolicyStatus.Payout;
            activePolicyCount--;
            emit PayoutAuthorized(policyId, p.amount);
            if (reserve.canPayClaim(policyId, p.amount)) {
                reserve.payClaim(policyId, p.buyer, p.amount);
                emit PayoutExecuted(policyId, p.amount);
            } else {
                p.status = PolicyStatus.ManualReview;
                emit ManualReviewRequired(policyId, "Insufficient reserve");
            }
        } else if (success >= QUORUM) {
            p.status = PolicyStatus.Completed;
            activePolicyCount--;
            emit PolicyCompleted(policyId);
        } else {
            p.status = PolicyStatus.ManualReview;
            emit ManualReviewRequired(policyId, "No quorum or mixed signals");
        }
    }

    function confirmDelivery(uint256 policyId, bytes32 paymentHash) external nonReentrant whenNotPaused {
        Policy storage p = policies[policyId];
        if (p.buyer == address(0)) revert PolicyDoesNotExist();
        if (p.buyer != msg.sender) revert OnlyBuyerCanRequest();
        if (p.status != PolicyStatus.Active) revert PolicyNotActive();
        p.status = PolicyStatus.Completed;
        activePolicyCount--;
        emit PolicyCompleted(policyId);
    }

    function addWatcher(address watcher) external onlyOwner {
        if (watcher == address(0)) revert ZeroAddress();
        if (isWatcher[watcher]) revert NotWatcher();
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

    function getWatchers() external view returns (address[] memory) { return watcherList; }
    function getPolicy(uint256 policyId) external view returns (Policy memory) { return policies[policyId]; }
    function hasPendingClaims() external view returns (bool) { return activePolicyCount > 0; }
    function isClaimApproved(uint256 claimId, address claimant, uint256 amount) external view override returns (bool) {
        Policy storage p = policies[claimId];
        return p.status == PolicyStatus.Payout && p.buyer == claimant && p.amount == amount;
    }
    function markClaimFulfilled(uint256 claimId) external override {
        if (msg.sender != address(reserve)) revert InvalidReserveAddress();
        emit PayoutExecuted(claimId, policies[claimId].amount);
    }
}