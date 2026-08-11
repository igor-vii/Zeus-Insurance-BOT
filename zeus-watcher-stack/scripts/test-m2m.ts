#!/usr/bin/env node
/**
 * M2M Flow Test Script
 * 
 * Tests the complete flow without UI/MetaMask:
 * 1. Create policy directly via contract
 * 2. Wait for watcher to detect
 * 3. Check policy status via API
 * 4. Check if observation was created
 * 
 * Usage: npx tsx scripts/test-m2m.ts
 */

import { ethers } from 'ethers';

// ── Configuration ──────────────────────────────────────────────────────────────
const RPC_URL = 'https://rpc.botchain.ai';
const CHAIN_ID = 677;

const CONTRACTS = {
  insurance: '0x2E592BEBbcC38FC3976125CB2E11312068670C45',
  usdt: '0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C',
};

const TEST_PARAMS = {
  seller: '0x1234567890123456789012345678901234567890',
  amount: ethers.parseUnits('100', 6), // 100 USDC (6 decimals)
  timeoutSeconds: 60,
  maxRetries: 3,
  premium: ethers.parseUnits('1', 6), // 1 USDC premium
};

const API_BASE = 'https://zeus-insurance-bot-api-production.up.railway.app/api';

// ── ABIs ───────────────────────────────────────────────────────────────────────
const INSURANCE_ABI = [
  'function buyPolicy(address seller, uint256 amount, uint256 timeoutSeconds, uint256 maxRetries, uint256 premium) external returns (uint256)',
  'event PolicyCreated(uint256 indexed policyId, address indexed buyer, address indexed seller, uint256 amount, uint256 premium, uint256 retryDeadline, uint8 coverageType)',
];

const USDT_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
];

// ── Main Test Function ─────────────────────────────────────────────────────────
async function main() {
  console.log('🚀 M2M Flow Test Started\n');

  // 1. Setup provider and wallet
  const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID);
  const privateKey = process.env.WATCHER_PRIVATE_KEY;
  
  if (!privateKey) {
    console.error('❌ Error: WATCHER_PRIVATE_KEY environment variable not set');
    process.exit(1);
  }

  const wallet = new ethers.Wallet(privateKey, provider);
  console.log(`✅ Wallet: ${wallet.address}`);
  console.log(`✅ Chain: BOT Chain (${CHAIN_ID})\n`);

  // 2. Check balance
  const balance = await provider.getBalance(wallet.address);
  console.log(`💰 Balance: ${ethers.formatEther(balance)} ETH`);

  const usdt = new ethers.Contract(CONTRACTS.usdt, USDT_ABI, wallet);
  const usdtBalance = await usdt.balanceOf(wallet.address);
  console.log(`💰 USDT Balance: ${ethers.formatUnits(usdtBalance, 6)} USDT\n`);

  // 3. Approve premium payment
  console.log('📝 Step 1: Approving premium payment...');
  const allowance = await usdt.allowance(wallet.address, CONTRACTS.insurance);
  
  if (allowance < TEST_PARAMS.premium) {
    console.log(`   Approving ${ethers.formatUnits(TEST_PARAMS.premium, 6)} USDT...`);
    const approveTx = await usdt.approve(CONTRACTS.insurance, TEST_PARAMS.premium);
    console.log(`   Tx sent: ${approveTx.hash}`);
    await approveTx.wait();
    console.log('   ✅ Approved\n');
  } else {
    console.log('   ✅ Already approved\n');
  }

  // 4. Create policy
  console.log('📝 Step 2: Creating policy via contract...');
  console.log(`   Seller: ${TEST_PARAMS.seller}`);
  console.log(`   Amount: ${ethers.formatUnits(TEST_PARAMS.amount, 6)} USDC`);
  console.log(`   Timeout: ${TEST_PARAMS.timeoutSeconds}s`);
  console.log(`   Max Retries: ${TEST_PARAMS.maxRetries}`);
  console.log(`   Premium: ${ethers.formatUnits(TEST_PARAMS.premium, 6)} USDT\n`);

  const insurance = new ethers.Contract(CONTRACTS.insurance, INSURANCE_ABI, wallet);
  
  const tx = await insurance.buyPolicy(
    TEST_PARAMS.seller,
    TEST_PARAMS.amount,
    TEST_PARAMS.timeoutSeconds,
    TEST_PARAMS.maxRetries,
    TEST_PARAMS.premium
  );

  console.log(`   Tx sent: ${tx.hash}`);
  console.log('   Waiting for confirmation...');

  const receipt = await tx.wait();
  console.log(`   ✅ Confirmed in block ${receipt.blockNumber}\n`);

  // 5. Extract policyId from event
  const policyCreatedEvent = receipt.logs.find(
    (log: any) => log.topics[0] === ethers.id('PolicyCreated(uint256,address,address,uint256,uint256,uint256,uint8)')
  );

  if (!policyCreatedEvent) {
    console.error('❌ PolicyCreated event not found in transaction logs');
    process.exit(1);
  }

  const policyId = BigInt(policyCreatedEvent.topics[1]);
  console.log(`🎉 Policy Created!`);
  console.log(`   Policy ID: ${policyId}`);
  console.log(`   Tx Hash: ${tx.hash}\n`);

  // 6. Wait for watcher
  console.log('⏳ Step 3: Waiting 30 seconds for watcher to detect policy...\n');
  for (let i = 30; i > 0; i--) {
    process.stdout.write(`   ${i}s remaining...\r`);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  console.log('   ✅ Wait complete\n');

  // 7. Check policy status via API
  console.log('📝 Step 4: Checking policy status via API...');
  const policiesUrl = `${API_BASE}/policies?buyer=${wallet.address}`;
  console.log(`   GET ${policiesUrl}\n`);

  try {
    const response = await fetch(policiesUrl);
    
    if (!response.ok) {
      console.error(`❌ API error: ${response.status} ${response.statusText}`);
      console.error(`   Response: ${await response.text()}`);
      process.exit(1);
    }

    const data = await response.json();
    
    if (data.policies && data.policies.length > 0) {
      const policy = data.policies.find((p: any) => p.id === policyId.toString());
      
      if (policy) {
        console.log('✅ Policy found in API!');
        console.log(`   Policy ID: ${policy.id}`);
        console.log(`   Status: ${policy.status}`);
        console.log(`   Active: ${policy.isActive}`);
        console.log(`   Paid Out: ${policy.isPaidOut}`);
        console.log(`   Expired: ${policy.isExpired}`);
        console.log(`   Buyer: ${policy.buyer}`);
        console.log(`   Seller: ${policy.seller}`);
        console.log(`   Amount: ${ethers.formatUnits(policy.amount, 6)} USDC\n`);
      } else {
        console.log('⚠️  Policy not found in API response');
        console.log(`   Found ${data.policies.length} policies for this buyer`);
        console.log(`   Expected policyId: ${policyId}\n`);
      }
    } else {
      console.log('⚠️  No policies found for this buyer\n');
    }
  } catch (error) {
    console.error('❌ Error fetching from API:', error);
    process.exit(1);
  }

  // 8. Check observations
  console.log('📝 Step 5: Checking for observations...');
  const observationsUrl = `${API_BASE}/observations?policyId=${policyId}`;
  console.log(`   GET ${observationsUrl}\n`);

  try {
    const response = await fetch(observationsUrl);
    
    if (response.ok) {
      const data = await response.json();
      
      if (data.observations && data.observations.length > 0) {
        console.log(`✅ Found ${data.observations.length} observation(s)!`);
        data.observations.forEach((obs: any, i: number) => {
          console.log(`\n   Observation ${i + 1}:`);
          console.log(`     Status: ${obs.status}`);
          console.log(`     Timestamp: ${new Date(obs.timestamp * 1000).toISOString()}`);
          console.log(`     Watcher: ${obs.watcher}`);
          console.log(`     Request ID: ${obs.requestId}`);
        });
      } else {
        console.log('⚠️  No observations found yet');
        console.log('   (Watcher may need more time or policy may not meet criteria)\n');
      }
    } else {
      console.log(`⚠️  Observations endpoint returned ${response.status}`);
      console.log('   (Endpoint may not exist or policy not yet processed)\n');
    }
  } catch (error) {
    console.log('⚠️  Could not fetch observations (endpoint may not exist)\n');
  }

  console.log('\n✨ M2M Flow Test Complete!');
  console.log('\nNext steps:');
  console.log('  1. Check Railway logs for watcher activity');
  console.log('  2. Verify policy status in UI: https://zeus-insurance-frontend.onrender.com/policies');
  console.log('  3. Wait for retryDeadline if testing claim flow');
}

main().catch(error => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
