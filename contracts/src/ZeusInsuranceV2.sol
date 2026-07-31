// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "./ZeusReserveV2.sol";
import "./interfaces/IInsuranceContract.sol";

/**
 * @title ZeusInsuranceV2
 * @notice Insurance contract that issues policies, collects USDT premiums into the
 *         reserve, and settles claims in two ways:
 *
 *         1. Timeout-based (buyer calls claimPayout after retryDeadline).
 *         2. Oracle-based (a quorum of registered watchers submit signed
 *            observations; the contract resolves the vote automatically).
 *
 * Integration flow:
 *   1. Deploy ZeusReserveV2.
 *   2. Deploy ZeusInsuranceV2(usdt, reserve).
 *   3. ZeusReserveV2.setInsuranceContract(address(this)).
 *   4. addWatcher() for each off-chain oracle node.
 *   5. Buyers call buyInsurance() — premium flows to reserve.
 *   6. Claim via claimPayout() OR via watcher observations (3-of-N voting).
 */
contract ZeusInsuranceV2 is IInsuranceContract, ReentrancyGuard, Ownable {

    // ── Enums ─────────────────────────────────────────────────────────────────

    /// @notice On-chain lifecycle status for each policy.
    enum PolicyStatus { Active, Claimed, Rejected, Expired }

    /// @notice Coverage type — Standard (API/uptime) or SlashingProtection (validator).
    enum CoverageType { Standard, SlashingProtection }

    // ── Structs ───────────────────────────────────────────────────────────────

    struct Policy {
        address buyer;
        address seller;
        uint256 amount;         // Coverage amount in USDT (6-decimal units)
        uint256 premium;        // Premium paid in USDT (6-decimal units)
        uint256 retryDeadline;  // Unix timestamp after which claimPayout is valid
        uint256 maxRetries;
        PolicyStatus status;
    }

    /**
     * @notice A signed observation submitted by a registered watcher node.
     *
     * @param requestId    keccak256(buyer, seller, timestamp) — unique per check.
     * @param timestamp    Unix time of the observation (±120 s tolerance).
     * @param status       Service health code: 0=OK 1=TIMEOUT 2=ERROR_500 3=LATE
     * @param metadataHash Arbitrary metadata digest (e.g. IPFS CID of raw logs).
     * @param nonce        Per-watcher anti-replay nonce.
     * @param signature    EIP-191 personal_sign over (requestId, timestamp, status,
     *                     metadataHash, nonce).
     */
    struct Observation {
        bytes32 requestId;
        uint256 timestamp;
        uint8   status;
        bytes32 metadataHash;
        uint256 nonce;
        bytes   signature;
    }

    /// @dev Per-requestId vote accumulator (no nested mapping — stored separately).
    struct VoteTally {
        uint256 policyId;
        uint8[] statuses;
        bool    resolved;
    }

    // ── State ─────────────────────────────────────────────────────────────────

    IERC20       public usdt;
    ZeusReserveV2 public reserve;

    mapping(uint256 => Policy)    public policies;
    uint256                       public nextPolicyId;

    // Watcher registry
    address[]                     public watcherList;
    mapping(address => bool)      public isWatcher;

    // Coverage type per policy
    mapping(uint256 => CoverageType)          public  policyCoverageType;

    /// @dev Slashing protection premium: 5 % of coverage amount.
    uint256 public constant SLASHING_PREMIUM_BPS = 500;

    // Oracle voting
    mapping(bytes32 => VoteTally)             public  pendingVotes;
    mapping(bytes32 => mapping(address => bool)) public hasVoted;
    mapping(bytes32 => bool)                  public  usedRequestIds;
    mapping(uint256 => bytes32)               public  policyToRequestId;

    // ── Events ────────────────────────────────────────────────────────────────

    event PolicyCreated(
        uint256 indexed policyId,
        address indexed buyer,
        address indexed seller,
        uint256 amount,
        uint256 premium,
        uint256 retryDeadline
    );
    event PayoutExecuted(uint256 indexed policyId, uint256 amount);
    event PolicyExpired(uint256 indexed policyId);

    event WatcherAdded(address indexed watcher);
    event WatcherRemoved(address indexed watcher);

    /// @notice Emitted when a watcher reports a slashing event for a SlashingProtection policy.
    event SlashingReported(
        uint256 indexed policyId,
        address indexed validator,
        bytes32 indexed evidenceHash
    );

    event ObservationSubmitted(
        bytes32 indexed requestId,
        address indexed watcher,
        uint8   status
    );
    event VoteResolved(
        bytes32 indexed requestId,
        uint8   decision,   // 1 = payout approved, 0 = claim rejected
        uint256 indexed policyId
    );
    event ClaimRejected(uint256 indexed policyId);

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor(address _usdt, address _reserve) Ownable(msg.sender) {
        require(_usdt    != address(0), "Invalid USDT address");
        require(_reserve != address(0), "Invalid reserve address");
        usdt    = IERC20(_usdt);
        reserve = ZeusReserveV2(_reserve);
    }

    // ── Policy management ─────────────────────────────────────────────────────

    /**
     * @notice Purchase an insurance policy.
     *
     * Premium formula (mirrors ZeusReserveV2 and the SDK):
     *   premiumBps = 700 + (maxRetries − 1) × 200
     *   premium    = amount × premiumBps / 10 000
     *
     * The USDT premium is transferred directly to the reserve.
     *
     * @param seller         Counterparty address being insured against.
     * @param amount         Coverage amount in USDT (6-decimal units).
     * @param timeoutSeconds Per-retry timeout window in seconds.
     * @param maxRetries     Number of retry windows allowed (1–10).
     */
    function buyInsurance(
        address seller,
        uint256 amount,
        uint256 timeoutSeconds,
        uint256 maxRetries
    ) external nonReentrant {
        require(seller      != address(0),           "Invalid seller");
        require(amount       > 0,                    "Amount must be > 0");
        require(maxRetries   > 0 && maxRetries <= 10,"Invalid retries");
        require(timeoutSeconds > 0,                  "Timeout must be > 0");

        uint256 premiumBps = 700 + (maxRetries - 1) * 200;
        uint256 premium    = (amount * premiumBps) / 10_000;

        require(
            usdt.transferFrom(msg.sender, address(reserve), premium),
            "Premium transfer failed"
        );

        uint256 retryDeadline = block.timestamp + timeoutSeconds * maxRetries;

        policies[nextPolicyId] = Policy({
            buyer:         msg.sender,
            seller:        seller,
            amount:        amount,
            premium:       premium,
            retryDeadline: retryDeadline,
            maxRetries:    maxRetries,
            status:        PolicyStatus.Active
        });

        emit PolicyCreated(nextPolicyId, msg.sender, seller, amount, premium, retryDeadline);
        nextPolicyId++;
    }

    /**
     * @notice Purchase a SlashingProtection policy for a BOT Chain validator.
     *
     * Premium = amount × 500 bps / 10 000 (5 %).
     * Sets coverageType = SlashingProtection; claim is triggered by a watcher
     * calling reportSlashing() rather than by a timeout.
     *
     * @param validator       Validator address being protected against slashing.
     * @param amount          Coverage amount in USDT (6-decimal units).
     * @param timeoutSeconds  Maximum window in seconds (policy expires if no slashing occurs).
     */
    function buySlashingProtection(
        address validator,
        uint256 amount,
        uint256 timeoutSeconds
    ) external nonReentrant {
        require(validator     != address(0), "Invalid validator");
        require(amount         > 0,          "Amount must be > 0");
        require(timeoutSeconds > 0,          "Timeout must be > 0");

        uint256 premium       = (amount * SLASHING_PREMIUM_BPS) / 10_000;
        uint256 retryDeadline = block.timestamp + timeoutSeconds;

        require(
            usdt.transferFrom(msg.sender, address(reserve), premium),
            "Premium transfer failed"
        );

        policies[nextPolicyId] = Policy({
            buyer:         msg.sender,
            seller:        validator,
            amount:        amount,
            premium:       premium,
            retryDeadline: retryDeadline,
            maxRetries:    1,
            status:        PolicyStatus.Active
        });
        policyCoverageType[nextPolicyId] = CoverageType.SlashingProtection;

        emit PolicyCreated(nextPolicyId, msg.sender, validator, amount, premium, retryDeadline);
        nextPolicyId++;
    }

    /**
     * @notice Watcher reports a confirmed on-chain slashing event for a protected validator.
     *
     * Only registered watchers can call this. Immediately triggers a full payout
     * to the policy buyer — no voting quorum needed (slashing evidence is deterministic).
     *
     * @param policyId      SlashingProtection policy to pay out.
     * @param evidenceHash  keccak256 of the slashing transaction hash / evidence.
     */
    function reportSlashing(
        uint256 policyId,
        bytes32 evidenceHash
    ) external nonReentrant {
        require(isWatcher[msg.sender],                                  "Only watchers can report slashing");
        Policy storage p = policies[policyId];
        require(p.buyer  != address(0),                                 "Policy does not exist");
        require(p.status == PolicyStatus.Active,                        "Policy not active");
        require(policyCoverageType[policyId] == CoverageType.SlashingProtection, "Not a slashing policy");

        address validator   = p.seller;
        uint256 payoutAmount = p.amount;
        address buyer        = p.buyer;

        p.status = PolicyStatus.Claimed; // CEI

        emit SlashingReported(policyId, validator, evidenceHash);
        reserve.payClaim(policyId, buyer, payoutAmount);
        emit PayoutExecuted(policyId, payoutAmount);
    }

    /**
     * @notice Timeout-based claim: buyer calls this once retryDeadline has passed.
     * @param policyId  The policy to claim against.
     */
    function claimPayout(uint256 policyId) external nonReentrant {
        Policy storage p = policies[policyId];
        require(p.buyer        == msg.sender,          "Only buyer can claim");
        require(p.status       == PolicyStatus.Active, "Policy not active");
        require(block.timestamp >= p.retryDeadline,    "Timeout not yet reached");

        uint256 payoutAmount = p.amount;
        address claimant     = p.buyer;

        p.status = PolicyStatus.Claimed; // CEI: state change before external call

        reserve.payClaim(policyId, claimant, payoutAmount);

        emit PayoutExecuted(policyId, payoutAmount);
    }

    // ── IInsuranceContract — callbacks from ZeusReserveV2 ────────────────────

    /**
     * @inheritdoc IInsuranceContract
     * @dev Used by ZeusReserveV2.payClaim() to verify the claim before paying.
     */
    function isClaimApproved(
        uint256 claimId,
        address claimant,
        uint256 amount
    ) external view override returns (bool) {
        Policy storage p = policies[claimId];
        return p.status == PolicyStatus.Claimed
            && p.buyer  == claimant
            && p.amount == amount;
    }

    /**
     * @inheritdoc IInsuranceContract
     * @dev Called by ZeusReserveV2 after the USDT payout has been sent.
     */
    function markClaimFulfilled(uint256 claimId) external override {
        require(msg.sender == address(reserve), "Only reserve can call");
        Policy storage p = policies[claimId];
        emit ClaimApproved(claimId, p.buyer, p.amount);
    }

    // ── Watcher management ────────────────────────────────────────────────────

    /**
     * @notice Register a new oracle watcher.
     * @param watcher  EOA address of the off-chain observer node.
     */
    function addWatcher(address watcher) external onlyOwner {
        require(watcher != address(0), "Zero address");
        require(!isWatcher[watcher],   "Already a watcher");
        isWatcher[watcher] = true;
        watcherList.push(watcher);
        emit WatcherAdded(watcher);
    }

    /**
     * @notice Deregister a watcher.
     * @param watcher  Address to remove from the watcher set.
     */
    function removeWatcher(address watcher) external onlyOwner {
        require(isWatcher[watcher], "Not a watcher");
        isWatcher[watcher] = false;
        emit WatcherRemoved(watcher);
    }

    /// @notice Returns the full list of currently registered watcher addresses.
    function getWatchers() external view returns (address[] memory) {
        return watcherList;
    }

    // ── Oracle observations ───────────────────────────────────────────────────

    /**
     * @notice Submit a signed health observation for a policy.
     *
     * Any address can relay a signed observation on behalf of a watcher —
     * authenticity is enforced by ECDSA signature recovery.
     *
     * Vote resolution fires automatically once ≥ 3 observations accumulate:
     *   - ≥ 2 TIMEOUT (status == 1) votes → payout approved.
     *   - Otherwise                       → claim rejected.
     *
     * @param policyId  ID of the policy being observed.
     * @param obs       The signed observation struct.
     */
    function submitObservation(uint256 policyId, Observation calldata obs) external {
        require(!usedRequestIds[obs.requestId], "Request ID already resolved");
        require(
            block.timestamp >= obs.timestamp - 120 &&
            block.timestamp <= obs.timestamp + 120,
            "Observation timestamp out of window"
        );

        address signer = _verifyObservation(obs);
        require(isWatcher[signer],                  "Invalid watcher signature");
        require(!hasVoted[obs.requestId][signer],   "Watcher already voted");

        Policy storage policy = policies[policyId];
        require(policy.buyer  != address(0),            "Policy does not exist");
        require(policy.status == PolicyStatus.Active,   "Policy not active");

        bytes32 expectedId = keccak256(
            abi.encodePacked(policy.buyer, policy.seller, obs.timestamp)
        );
        require(obs.requestId == expectedId, "Invalid requestId");

        VoteTally storage vote = pendingVotes[obs.requestId];
        if (vote.policyId == 0) {
            vote.policyId = policyId;
            policyToRequestId[policyId] = obs.requestId;
        } else {
            require(vote.policyId == policyId, "Policy ID mismatch");
        }

        hasVoted[obs.requestId][signer] = true;
        vote.statuses.push(obs.status);

        emit ObservationSubmitted(obs.requestId, signer, obs.status);

        if (vote.statuses.length >= 3) {
            _resolveVote(obs.requestId);
        }
    }

    // ── Owner configuration ───────────────────────────────────────────────────

    function setReserve(address _reserve) external onlyOwner {
        require(_reserve != address(0), "Invalid reserve address");
        reserve = ZeusReserveV2(_reserve);
    }

    function setUsdt(address _usdt) external onlyOwner {
        require(_usdt != address(0), "Invalid USDT address");
        usdt = IERC20(_usdt);
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    function getPolicy(uint256 policyId) external view returns (Policy memory) {
        return policies[policyId];
    }

    /// @notice Returns the coverage type of a policy (0 = Standard, 1 = SlashingProtection).
    function getCoverageType(uint256 policyId) external view returns (CoverageType) {
        return policyCoverageType[policyId];
    }

    /**
     * @notice Check whether a policy is currently claimable.
     *
     * Returns true only when ALL of the following hold:
     *   1. Policy exists (buyer != address(0)).
     *   2. Policy status is Active (not already Claimed / Rejected / Expired).
     *   3. The retry deadline has been reached (block.timestamp >= retryDeadline).
     *   4. The reserve holds at least the policy coverage amount in USDT.
     *
     * @param policyId  ID of the policy to check.
     */
    function canClaim(uint256 policyId) external view returns (bool) {
        Policy storage p = policies[policyId];
        if (p.buyer == address(0))                  return false; // does not exist
        if (p.status != PolicyStatus.Active)        return false; // not active
        if (block.timestamp < p.retryDeadline)      return false; // timeout not yet reached
        if (usdt.balanceOf(address(reserve)) < p.amount) return false; // reserve insufficient
        return true;
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    function _verifyObservation(Observation calldata obs) internal pure returns (address) {
        bytes32 msgHash = keccak256(abi.encodePacked(
            obs.requestId,
            obs.timestamp,
            obs.status,
            obs.metadataHash,
            obs.nonce
        ));
        bytes32 ethHash = MessageHashUtils.toEthSignedMessageHash(msgHash);
        return ECDSA.recover(ethHash, obs.signature);
    }

    function _resolveVote(bytes32 requestId) internal {
        VoteTally storage vote = pendingVotes[requestId];
        require(!vote.resolved, "Vote already resolved");

        usedRequestIds[requestId] = true;
        vote.resolved = true;

        uint256 timeoutCount = 0;
        for (uint256 i = 0; i < vote.statuses.length; i++) {
            if (vote.statuses[i] == 1) timeoutCount++;
        }

        if (timeoutCount >= 2) {
            emit VoteResolved(requestId, 1, vote.policyId);
            _triggerOraclePayout(vote.policyId);
        } else {
            emit VoteResolved(requestId, 0, vote.policyId);
            _rejectClaim(vote.policyId);
        }
    }

    function _triggerOraclePayout(uint256 policyId) internal {
        Policy storage p = policies[policyId];
        require(p.status == PolicyStatus.Active, "Policy not active");

        uint256 amount  = p.amount;
        address buyer   = p.buyer;

        p.status = PolicyStatus.Claimed; // CEI

        reserve.payClaim(policyId, buyer, amount);

        emit PayoutExecuted(policyId, amount);
    }

    function _rejectClaim(uint256 policyId) internal {
        Policy storage p = policies[policyId];
        require(p.status == PolicyStatus.Active, "Policy not active");
        p.status = PolicyStatus.Rejected;
        emit ClaimRejected(policyId);
    }
}
