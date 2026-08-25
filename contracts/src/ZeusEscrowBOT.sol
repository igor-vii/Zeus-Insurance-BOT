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
 *   Signers   — (MultiSig only) approve the release of funds.
 *
 * Flow:
 *   1. Initiator calls depositAndCreateAgreement() or createMultiSigEscrow() — tokens are locked.
 *      A protocol fee (0.7% + $0.02 fixed) is deducted and sent to the treasury.
 *   2. Executor calls confirmExecution() (Single) OR releaseMultiSig() (MultiSig) — locked tokens are released.
 *      OR
 *   3. Initiator calls requestRefund() after timeout — locked tokens are returned.
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
    enum EscrowType { Single, MultiSig }

    struct Agreement {
        address initiator;   // Party that deposited funds
        address executor;    // Party that must fulfill the agreement
        uint256 amount;      // Token amount locked in escrow (after fee, token-native units)
        uint256 timeout;     // Duration in seconds before initiator may refund
        uint256 createdAt;   // Block timestamp at agreement creation
        AgreementStatus status;
        bytes proof;         // Off-chain proof submitted by executor (stored as-is, not validated)
        EscrowType escrowType; // Type of escrow (Single or MultiSig)
        uint256 requiredSignatures; // (MultiSig) Required signatures to release
        uint256 signaturesCount;    // (MultiSig) Current signatures collected
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

    /// @notice agreementId => signers list (для оффчейн чтения)
    mapping(uint256 => address[]) public signersList;
    
    /// @notice agreementId => signer => bool (O(1) проверка прав)
    mapping(uint256 => mapping(address => bool)) public isSigner;
    
    /// @notice agreementId => signer => bool (проверка, проголосовал ли уже)
    mapping(uint256 => mapping(address => bool)) public hasSigned;

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

    // MultiSig Events
    event MultiSigSignerAdded(uint256 indexed agreementId, address indexed signer);
    event MultiSigSignerRemoved(uint256 indexed agreementId, address indexed signer);
    event MultiSigVote(uint256 indexed agreementId, address indexed signer, uint256 count);
    event MultiSigReleased(uint256 indexed agreementId, address indexed executor, uint256 amount);

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(address _token, address _treasury) {
        require(_token != address(0), "ZeusEscrowBOT: zero token address");
        token    = IERC20(_token);
        treasury = _treasury;
    }

    // -------------------------------------------------------------------------
    // Internal helpers
    // -------------------------------------------------------------------------

    /**
     * @dev Расчет комиссии, перевод комиссии в treasury и возврат суммы к блокировке.
     */
    function _processFee(uint256 amount, uint256 agreementId) internal returns (uint256 amountToLock) {
        amountToLock = amount;

        if (treasury != address(0)) {
            uint256 percentFee = (amount * PROTOCOL_PERCENT_FEE_BPS) / 10_000;
            uint256 totalFee   = PROTOCOL_FIXED_FEE + percentFee;
            require(amount > totalFee, "ZeusEscrowBOT: amount too small to cover fee");

            amountToLock = amount - totalFee;

            // Transfer fee to treasury
            token.safeTransferFrom(msg.sender, treasury, totalFee);
            emit FeeCollected(agreementId, treasury, totalFee);
        }
    }

    // -------------------------------------------------------------------------
    // Initiator actions
    // -------------------------------------------------------------------------

    /**
     * @notice Deposit tokens and open a new standard escrow agreement.
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

        agreementId = ++agreementCount;
        uint256 amountToLock = _processFee(amount, agreementId);

        // Lock the net amount in this contract
        token.safeTransferFrom(msg.sender, address(this), amountToLock);

        agreements[agreementId] = Agreement({
            initiator: msg.sender,
            executor:  executor,
            amount:    amountToLock,
            timeout:   timeout,
            createdAt: block.timestamp,
            status:    AgreementStatus.Active,
            proof:     "",
            escrowType: EscrowType.Single,
            requiredSignatures: 0,
            signaturesCount: 0
        });

        emit AgreementCreated(agreementId, msg.sender, executor, amountToLock, timeout, block.timestamp);
    }

    /**
     * @notice Deposit tokens and open a new MultiSig escrow agreement.
     * @param _signers Array of addresses allowed to sign the release.
     * @param requiredSignatures Number of signatures needed to release funds.
     */
    function createMultiSigEscrow(
        address executor,
        uint256 amount,
        uint256 timeout,
        address[] calldata _signers,
        uint256 requiredSignatures
    ) external nonReentrant returns (uint256 agreementId) {
        require(executor != address(0),   "ZeusEscrowBOT: zero executor address");
        require(executor != msg.sender,   "ZeusEscrowBOT: initiator and executor must differ");
        require(amount  > 0,              "ZeusEscrowBOT: amount must be positive");
        require(timeout > 0,              "ZeusEscrowBOT: timeout must be positive");
        require(_signers.length > 0,      "ZeusEscrowBOT: zero signers");
        require(requiredSignatures > 0 && requiredSignatures <= _signers.length, "ZeusEscrowBOT: bad required sigs");

        agreementId = ++agreementCount;
        uint256 amountToLock = _processFee(amount, agreementId);

        token.safeTransferFrom(msg.sender, address(this), amountToLock);

        agreements[agreementId] = Agreement({
            initiator: msg.sender,
            executor:  executor,
            amount:    amountToLock,
            timeout:   timeout,
            createdAt: block.timestamp,
            status:    AgreementStatus.Active,
            proof:     "",
            escrowType: EscrowType.MultiSig,
            requiredSignatures: requiredSignatures,
            signaturesCount: 0
        });

        // Заполняем маппинг и массив подписантов
        for (uint256 i = 0; i < _signers.length; i++) {
            require(_signers[i] != address(0), "ZeusEscrowBOT: zero signer");
            require(!isSigner[agreementId][_signers[i]], "ZeusEscrowBOT: duplicate signer");
            
            isSigner[agreementId][_signers[i]] = true;
            signersList[agreementId].push(_signers[i]);
            emit MultiSigSignerAdded(agreementId, _signers[i]);
        }

        emit AgreementCreated(agreementId, msg.sender, executor, amountToLock, timeout, block.timestamp);
    }

    /**
     * @notice Initiator reclaims funds when the executor has not delivered within the timeout.
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
    // Executor / Signer actions
    // -------------------------------------------------------------------------

    /**
     * @notice Executor confirms delivery and releases escrowed tokens to themselves (Single Escrow).
     */
    function confirmExecution(
        uint256 agreementId,
        bytes calldata proof
    ) external nonReentrant {
        Agreement storage ag = agreements[agreementId];

        require(ag.initiator != address(0),           "ZeusEscrowBOT: agreement does not exist");
        require(ag.status == AgreementStatus.Active,  "ZeusEscrowBOT: agreement not active");
        require(ag.escrowType == EscrowType.Single,   "ZeusEscrowBOT: not single escrow");
        require(msg.sender == ag.executor,            "ZeusEscrowBOT: only executor can confirm");

        ag.status = AgreementStatus.Completed;
        ag.proof  = proof;
        token.safeTransfer(ag.executor, ag.amount);

        emit ExecutionConfirmed(agreementId, ag.executor, ag.amount, proof);
    }

    /**
     * @notice Signer votes to approve release of MultiSig escrow.
     *         O(1) gas check via mapping.
     */
    function sign(uint256 agreementId) external nonReentrant {
        Agreement storage ag = agreements[agreementId];

        require(ag.initiator != address(0),           "ZeusEscrowBOT: agreement does not exist");
        require(ag.status == AgreementStatus.Active,  "ZeusEscrowBOT: agreement not active");
        require(ag.escrowType == EscrowType.MultiSig, "ZeusEscrowBOT: not multisig");
        
        // O(1) ПРОВЕРКА!
        require(isSigner[agreementId][msg.sender],    "ZeusEscrowBOT: not signer");
        require(!hasSigned[agreementId][msg.sender],  "ZeusEscrowBOT: already signed");
        
        hasSigned[agreementId][msg.sender] = true;
        ag.signaturesCount += 1;
        
        emit MultiSigVote(agreementId, msg.sender, ag.signaturesCount);
    }

    /**
     * @notice Releases funds to executor if required signatures threshold is met.
     */
    function releaseMultiSig(uint256 agreementId, bytes calldata proof) external nonReentrant {
        Agreement storage ag = agreements[agreementId];

        require(ag.initiator != address(0),           "ZeusEscrowBOT: agreement does not exist");
        require(ag.status == AgreementStatus.Active,  "ZeusEscrowBOT: agreement not active");
        require(ag.escrowType == EscrowType.MultiSig, "ZeusEscrowBOT: not multisig");
        require(ag.signaturesCount >= ag.requiredSignatures, "ZeusEscrowBOT: not enough signatures");

        ag.status = AgreementStatus.Completed;
        ag.proof  = proof;
        token.safeTransfer(ag.executor, ag.amount);

        emit ExecutionConfirmed(agreementId, ag.executor, ag.amount, proof);
        emit MultiSigReleased(agreementId, ag.executor, ag.amount);
    }

    /**
     * @notice Remove a signer from a MultiSig escrow (Initiator only).
     * @dev Uses swap-and-pop pattern to remove from array in O(1).
     */
    function removeSigner(uint256 agreementId, address signer) external nonReentrant {
        Agreement storage ag = agreements[agreementId];
        
        require(ag.initiator != address(0), "ZeusEscrowBOT: agreement does not exist");
        require(ag.escrowType == EscrowType.MultiSig, "ZeusEscrowBOT: not multisig");
        require(msg.sender == ag.initiator, "ZeusEscrowBOT: only initiator");
        require(isSigner[agreementId][signer], "ZeusEscrowBOT: not a signer");
        require(ag.requiredSignatures < signersList[agreementId].length, "ZeusEscrowBOT: cannot remove required signer");

        // Удаляем из O(1) маппинга
        isSigner[agreementId][signer] = false;

        // Удаляем из массива (swap-and-pop)
        address[] storage sigs = signersList[agreementId];
        for (uint256 i = 0; i < sigs.length; i++) {
            if (sigs[i] == signer) {
                sigs[i] = sigs[sigs.length - 1]; // Копируем последний элемент на место удаляемого
                sigs.pop(); // Удаляем последний элемент
                break;
            }
        }

        emit MultiSigSignerRemoved(agreementId, signer);
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

    /**
     * @notice Returns the list of signers for a MultiSig agreement.
     */
    function getSigners(uint256 agreementId) external view returns (address[] memory) {
        return signersList[agreementId];
    }
}
