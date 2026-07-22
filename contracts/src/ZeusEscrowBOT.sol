// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title ZeusEscrowBOT
 * @notice Trustless ERC-20 escrow for BOT Chain transactions.
 *
 * Roles:
 *   Initiator — funds the agreement (the paying party).
 *   Executor  — fulfills the agreement and receives payment.
 *
 * Flow:
 *   1. Initiator calls depositAndCreateAgreement() — tokens are locked in escrow.
 *      A protocol fee (0.7% + $0.02 fixed) is deducted and sent to the treasury.
 *   2. Executor calls confirmExecution() after delivering — locked tokens are released.
 *      OR
 *   3. Initiator calls requestRefund() after timeout — locked tokens are returned.
 *
 * Fee notes:
 *   - Assumes the escrow token uses 6 decimals (e.g. USDT).
 *   - If treasury is address(0) at construction, no fee is charged (test/local mode).
 */
contract ZeusEscrowBOT is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // -------------------------------------------------------------------------
    // Protocol fee constants  (assumes 6-decimal token such as USDT)
    // -------------------------------------------------------------------------

    /// @notice Fixed per-agreement fee: $0.02 (20 000 in 6-decimal units).
    uint256 public constant PROTOCOL_FIXED_FEE = 20_000;

    /// @notice Percentage fee in basis points: 70 bps = 0.7%.
    uint256 public constant PROTOCOL_PERCENT_FEE_BPS = 70;

    // -------------------------------------------------------------------------
    // Types
    // -------------------------------------------------------------------------

    enum AgreementStatus { Active, Completed, Refunded }

    struct Agreement {
        address initiator;   // Party that deposited funds
        address executor;    // Party that must fulfill the agreement
        uint256 amount;      // Token amount locked in escrow (after fee, token-native units)
        uint256 timeout;     // Duration in seconds before initiator may refund
        uint256 createdAt;   // Block timestamp at agreement creation
        AgreementStatus status;
        bytes proof;         // Off-chain proof submitted by executor (stored as-is, not validated)
    }

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------

    /// @notice The ERC-20 token used for all agreements (e.g. USDT).
    IERC20 public immutable token;

    /// @notice Treasury wallet that receives protocol fees.
    ///         address(0) means no fee is charged (useful for testing / local deployments).
    address public immutable treasury;

    /// @notice Auto-incrementing agreement counter; also used as the agreement ID.
    uint256 public agreementCount;

    /// @notice agreementId => Agreement
    mapping(uint256 => Agreement) public agreements;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event AgreementCreated(
        uint256 indexed agreementId,
        address indexed initiator,
        address indexed executor,
        uint256 amount,     // amount locked (after fee)
        uint256 timeout,
        uint256 createdAt
    );

    /// @notice Emitted when a protocol fee is collected.
    event FeeCollected(
        uint256 indexed agreementId,
        address indexed treasury,
        uint256 fee
    );

    /// @param proof  Off-chain evidence submitted by the executor.
    event ExecutionConfirmed(
        uint256 indexed agreementId,
        address indexed executor,
        uint256 amount,
        bytes   proof
    );

    event RefundIssued(
        uint256 indexed agreementId,
        address indexed initiator,
        uint256 amount
    );

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    /**
     * @param _token    Address of the ERC-20 token used for escrow settlements.
     * @param _treasury Address that receives protocol fees.
     *                  Pass address(0) to disable fees (local / testing deployments).
     */
    constructor(address _token, address _treasury) {
        require(_token != address(0), "ZeusEscrowBOT: zero token address");
        token    = IERC20(_token);
        treasury = _treasury;
    }

    // -------------------------------------------------------------------------
    // Initiator actions
    // -------------------------------------------------------------------------

    /**
     * @notice Deposit tokens and open a new escrow agreement.
     *
     * When treasury is configured, a protocol fee is deducted from `amount`:
     *   fee = PROTOCOL_FIXED_FEE + (amount * PROTOCOL_PERCENT_FEE_BPS / 10 000)
     *   lockedAmount = amount - fee
     *
     * The caller must approve this contract for the full `amount` (including fee).
     *
     * @param executor  Address of the party that must fulfill the agreement.
     * @param amount    Total token amount to transfer (fee + locked), in token-native units.
     * @param timeout   Seconds from now after which the initiator may request a refund.
     * @return agreementId  The ID of the newly created agreement.
     */
    function depositAndCreateAgreement(
        address executor,
        uint256 amount,
        uint256 timeout
    ) external nonReentrant returns (uint256 agreementId) {
        require(executor != address(0),   "ZeusEscrowBOT: zero executor address");
        require(executor != msg.sender,   "ZeusEscrowBOT: initiator and executor must differ");
        require(amount  > 0,              "ZeusEscrowBOT: amount must be positive");
        require(timeout > 0,              "ZeusEscrowBOT: timeout must be positive");

        uint256 amountToLock = amount;

        if (treasury != address(0)) {
            uint256 percentFee = (amount * PROTOCOL_PERCENT_FEE_BPS) / 10_000;
            uint256 totalFee   = PROTOCOL_FIXED_FEE + percentFee;
            require(amount > totalFee, "ZeusEscrowBOT: amount too small to cover fee");

            amountToLock = amount - totalFee;

            // Transfer fee to treasury
            token.safeTransferFrom(msg.sender, treasury, totalFee);

            agreementId = ++agreementCount;
            emit FeeCollected(agreementId, treasury, totalFee);
        } else {
            agreementId = ++agreementCount;
        }

        // Lock the net amount in this contract
        token.safeTransferFrom(msg.sender, address(this), amountToLock);

        agreements[agreementId] = Agreement({
            initiator: msg.sender,
            executor:  executor,
            amount:    amountToLock,
            timeout:   timeout,
            createdAt: block.timestamp,
            status:    AgreementStatus.Active,
            proof:     ""
        });

        emit AgreementCreated(
            agreementId,
            msg.sender,
            executor,
            amountToLock,
            timeout,
            block.timestamp
        );
    }

    /**
     * @notice Initiator reclaims funds when the executor has not delivered within the timeout.
     * @param agreementId  ID of the agreement to refund.
     */
    function requestRefund(uint256 agreementId) external nonReentrant {
        Agreement storage ag = agreements[agreementId];

        require(ag.initiator != address(0),           "ZeusEscrowBOT: agreement does not exist");
        require(ag.status == AgreementStatus.Active,  "ZeusEscrowBOT: agreement not active");
        require(msg.sender == ag.initiator,           "ZeusEscrowBOT: only initiator can request refund");
        require(
            block.timestamp >= ag.createdAt + ag.timeout,
            "ZeusEscrowBOT: timeout has not elapsed yet"
        );

        ag.status = AgreementStatus.Refunded;
        token.safeTransfer(ag.initiator, ag.amount);

        emit RefundIssued(agreementId, ag.initiator, ag.amount);
    }

    // -------------------------------------------------------------------------
    // Executor actions
    // -------------------------------------------------------------------------

    /**
     * @notice Executor confirms delivery and releases escrowed tokens to themselves.
     * @param agreementId  ID of the agreement being fulfilled.
     * @param proof        Off-chain proof of delivery (e.g. IPFS CID, tx hash, signed receipt).
     */
    function confirmExecution(
        uint256 agreementId,
        bytes calldata proof
    ) external nonReentrant {
        Agreement storage ag = agreements[agreementId];

        require(ag.initiator != address(0),           "ZeusEscrowBOT: agreement does not exist");
        require(ag.status == AgreementStatus.Active,  "ZeusEscrowBOT: agreement not active");
        require(msg.sender == ag.executor,            "ZeusEscrowBOT: only executor can confirm");

        ag.status = AgreementStatus.Completed;
        ag.proof  = proof;
        token.safeTransfer(ag.executor, ag.amount);

        emit ExecutionConfirmed(agreementId, ag.executor, ag.amount, proof);
    }

    // -------------------------------------------------------------------------
    // View helpers
    // -------------------------------------------------------------------------

    /**
     * @notice Returns full details for a given agreement.
     */
    function getAgreement(uint256 agreementId)
        external
        view
        returns (Agreement memory)
    {
        require(
            agreements[agreementId].initiator != address(0),
            "ZeusEscrowBOT: agreement does not exist"
        );
        return agreements[agreementId];
    }
}
