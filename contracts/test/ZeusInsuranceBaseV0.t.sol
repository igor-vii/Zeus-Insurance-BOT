// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "forge-std/Test.sol";
import "../src/ZeusInsuranceBaseV0.sol";
import "../src/ZeusReserveV2.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract ZeusInsuranceBaseV0Test is Test {
    ZeusInsuranceBaseV0 public insurance;
    ZeusReserveV2 public reserve;
    IERC20 public settlementToken;
    
    address public buyer = address(0x1);
    address public counterparty = address(0x2);
    address public watcher1 = address(0x3);
    address public watcher2 = address(0x4);
    address public watcher3 = address(0x5);
    
    uint256 constant INITIAL_BALANCE = 10000 * 10**6;
    uint256 constant POLICY_AMOUNT = 100 * 10**6;
    uint256 constant PREMIUM = 7 * 10**6;
    uint256 constant TIMEOUT = 1 hours;
    bytes32 constant OPERATION_ID = keccak256("test-operation-001");

    function setUp() public {
        settlementToken = IERC20(address(new MockERC20("USD Coin", "USDC", 6)));
        reserve = new ZeusReserveV2(address(settlementToken));
        MockERC20(address(settlementToken)).mint(address(reserve), 10000 * 10**6);
        insurance = new ZeusInsuranceBaseV0(address(settlementToken), address(reserve));
        insurance.addWatcher(watcher1);
        insurance.addWatcher(watcher2);
        insurance.addWatcher(watcher3);
        MockERC20(address(settlementToken)).mint(buyer, INITIAL_BALANCE);
        vm.prank(buyer);
        settlementToken.approve(address(insurance), type(uint256).max);
    }

    function test_T1_HappyPath_ConfirmDelivery() public {
        vm.prank(buyer);
        uint256 policyId = insurance.buyPolicy(counterparty, POLICY_AMOUNT, TIMEOUT, PREMIUM, OPERATION_ID);
        ZeusInsuranceBaseV0.Policy memory p = insurance.getPolicy(policyId);
        assertEq(uint8(p.status), uint8(ZeusInsuranceBaseV0.PolicyStatus.Active));
        
        vm.prank(buyer);
        insurance.confirmDelivery(policyId, keccak256("payment-tx-hash"));
        
        p = insurance.getPolicy(policyId);
        assertEq(uint8(p.status), uint8(ZeusInsuranceBaseV0.PolicyStatus.Completed));
        assertEq(insurance.activePolicyCount(), 0);
    }

    function test_T2_FailurePath_TimeoutQuorum() public {
        vm.prank(buyer);
        uint256 policyId = insurance.buyPolicy(counterparty, POLICY_AMOUNT, TIMEOUT, PREMIUM, OPERATION_ID);
        vm.warp(block.timestamp + TIMEOUT + 1);
        
        vm.prank(buyer);
        insurance.requestReview(policyId);
        bytes32 requestId = insurance.policyToRequestId(policyId);
        assertTrue(requestId != bytes32(0));
        
        _submitObs(watcher1, policyId, requestId, 1);
        _submitObs(watcher2, policyId, requestId, 1);
        
        ZeusInsuranceBaseV0.Policy memory p = insurance.getPolicy(policyId);
        assertEq(uint8(p.status), uint8(ZeusInsuranceBaseV0.PolicyStatus.Payout));
    }

    function test_T3_SuccessQuorum() public {
        vm.prank(buyer);
        uint256 policyId = insurance.buyPolicy(counterparty, POLICY_AMOUNT, TIMEOUT, PREMIUM, OPERATION_ID);
        vm.warp(block.timestamp + TIMEOUT + 1);
        vm.prank(buyer);
        insurance.requestReview(policyId);
        bytes32 requestId = insurance.policyToRequestId(policyId);
        
        _submitObs(watcher1, policyId, requestId, 0);
        _submitObs(watcher2, policyId, requestId, 0);
        
        ZeusInsuranceBaseV0.Policy memory p = insurance.getPolicy(policyId);
        assertEq(uint8(p.status), uint8(ZeusInsuranceBaseV0.PolicyStatus.Completed));
    }

    function test_T4_ManualReview_MixedSignals() public {
        vm.prank(buyer);
        uint256 policyId = insurance.buyPolicy(counterparty, POLICY_AMOUNT, TIMEOUT, PREMIUM, OPERATION_ID);
        vm.warp(block.timestamp + TIMEOUT + 1);
        vm.prank(buyer);
        insurance.requestReview(policyId);
        bytes32 requestId = insurance.policyToRequestId(policyId);
        
        _submitObs(watcher1, policyId, requestId, 1);
        _submitObs(watcher2, policyId, requestId, 0);
        
        ZeusInsuranceBaseV0.Policy memory p = insurance.getPolicy(policyId);
        assertEq(uint8(p.status), uint8(ZeusInsuranceBaseV0.PolicyStatus.ManualReview));
    }

    function test_T6_DuplicateVoteProtection() public {
        vm.prank(buyer);
        uint256 policyId = insurance.buyPolicy(counterparty, POLICY_AMOUNT, TIMEOUT, PREMIUM, OPERATION_ID);
        vm.warp(block.timestamp + TIMEOUT + 1);
        vm.prank(buyer);
        insurance.requestReview(policyId);
        bytes32 requestId = insurance.policyToRequestId(policyId);
        
        _submitObs(watcher1, policyId, requestId, 1);
        
        vm.expectRevert(ZeusInsuranceBaseV0.WatcherAlreadyVoted.selector);
        _submitObsRaw(watcher1, policyId, requestId, 1);
    }

    function test_T7_DeadlineEnforcement() public {
        vm.prank(buyer);
        uint256 policyId = insurance.buyPolicy(counterparty, POLICY_AMOUNT, TIMEOUT, PREMIUM, OPERATION_ID);
        vm.expectRevert(ZeusInsuranceBaseV0.DeadlineNotReached.selector);
        vm.prank(buyer);
        insurance.requestReview(policyId);
    }

    function test_T8_OnlyBuyerCanRequest() public {
        vm.prank(buyer);
        uint256 policyId = insurance.buyPolicy(counterparty, POLICY_AMOUNT, TIMEOUT, PREMIUM, OPERATION_ID);
        vm.warp(block.timestamp + TIMEOUT + 1);
        vm.expectRevert(ZeusInsuranceBaseV0.OnlyBuyerCanRequest.selector);
        vm.prank(counterparty);
        insurance.requestReview(policyId);
    }

    function test_T9_WatcherAuthority() public {
        vm.prank(buyer);
        uint256 policyId = insurance.buyPolicy(counterparty, POLICY_AMOUNT, TIMEOUT, PREMIUM, OPERATION_ID);
        vm.warp(block.timestamp + TIMEOUT + 1);
        vm.prank(buyer);
        insurance.requestReview(policyId);
        bytes32 requestId = insurance.policyToRequestId(policyId);
        
        vm.expectRevert(ZeusInsuranceBaseV0.NotWatcher.selector);
        _submitObsRaw(address(0x999), policyId, requestId, 1);
    }

    function test_T11_PolicyExistenceCheck() public {
        vm.expectRevert(ZeusInsuranceBaseV0.PolicyDoesNotExist.selector);
        vm.prank(buyer);
        insurance.requestReview(999);
    }

    function test_T12_SettlementTokenUniversality() public {
        IERC20 altToken = IERC20(address(new MockERC20("Tether USD", "USDT", 6)));
        ZeusReserveV2 altReserve = new ZeusReserveV2(address(altToken));
        MockERC20(address(altToken)).mint(address(altReserve), 10000 * 10**6);
        ZeusInsuranceBaseV0 altIns = new ZeusInsuranceBaseV0(address(altToken), address(altReserve));
        altIns.addWatcher(watcher1);
        altIns.addWatcher(watcher2);
        MockERC20(address(altToken)).mint(buyer, INITIAL_BALANCE);
        vm.prank(buyer);
        altToken.approve(address(altIns), type(uint256).max);
        
        vm.prank(buyer);
        uint256 pid = altIns.buyPolicy(counterparty, POLICY_AMOUNT, TIMEOUT, PREMIUM, OPERATION_ID);
        vm.prank(buyer);
        altIns.confirmDelivery(pid, keccak256("alt-pay"));
        
        assertEq(uint8(altIns.getPolicy(pid).status), uint8(ZeusInsuranceBaseV0.PolicyStatus.Completed));
    }

    function _submitObs(address w, uint256 pid, bytes32 rid, uint8 outcome) internal {
        uint256 ts = block.timestamp;
        bytes32 eh = keccak256("evidence");
        bytes32 mh = keccak256(abi.encodePacked(rid, pid, outcome, eh, ts));
        bytes32 eth = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", mh));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(uint256(keccak256(abi.encodePacked(w))), eth);
        bytes memory sig = abi.encodePacked(r, s, v);
        ZeusInsuranceBaseV0.Observation memory obs = ZeusInsuranceBaseV0.Observation({requestId: rid, policyId: pid, outcome: outcome, evidenceHash: eh, timestamp: ts, signature: sig});
        vm.prank(w);
        insurance.submitObservation(obs);
    }

    function _submitObsRaw(address w, uint256 pid, bytes32 rid, uint8 outcome) internal {
        uint256 ts = block.timestamp;
        bytes32 eh = keccak256("evidence");
        bytes32 mh = keccak256(abi.encodePacked(rid, pid, outcome, eh, ts));
        bytes32 eth = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", mh));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(uint256(keccak256(abi.encodePacked(w))), eth);
        bytes memory sig = abi.encodePacked(r, s, v);
        ZeusInsuranceBaseV0.Observation memory obs = ZeusInsuranceBaseV0.Observation({requestId: rid, policyId: pid, outcome: outcome, evidenceHash: eh, timestamp: ts, signature: sig});
        vm.prank(w);
        insurance.submitObservation(obs);
    }
}

contract MockERC20 is IERC20 {
    string public name;
    string public symbol;
    uint8 public decimals;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    constructor(string memory n, string memory s, uint8 d) { name=n; symbol=s; decimals=d; }
    function mint(address to, uint256 amt) external { balanceOf[to]+=amt; totalSupply+=amt; emit Transfer(address(0),to,amt); }
    function transfer(address to, uint256 amt) external returns(bool) { balanceOf[msg.sender]-=amt; balanceOf[to]+=amt; emit Transfer(msg.sender,to,amt); return true; }
    function approve(address sp, uint256 amt) external returns(bool) { allowance[msg.sender][sp]=amt; emit Approval(msg.sender,sp,amt); return true; }
    function transferFrom(address fr, address to, uint256 amt) external returns(bool) { allowance[fr][msg.sender]-=amt; balanceOf[fr]-=amt; balanceOf[to]+=amt; emit Transfer(fr,to,amt); return true; }
}
