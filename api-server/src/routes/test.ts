import { Router } from 'express';
import { ethers } from 'ethers';
import { z } from 'zod';
import { logger } from '../lib/logger.js';

const router = Router();

// ── ABIs ─────────────────────────────────────────────────────────────────────
const USDT_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
];

const INSURANCE_ABI = [
  'function buyInsurance(address seller, uint256 amount, uint256 timeoutSeconds, uint256 maxRetries) external payable returns (uint256)',
  'event PolicyCreated(uint256 indexed policyId, address indexed buyer, address indexed seller, uint256 amount, uint256 premium, uint256 retryDeadline)',
];

// ── Contracts ────────────────────────────────────────────────────────────────
const CONTRACTS = {
  insurance: '0x2E592BEBbcC38FC3976125CB2E11312068670C45',
  usdt: '0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C',
};

const RPC_URL = 'https://rpc.botchain.ai';

// ── Request Schema ───────────────────────────────────────────────────────────
const createPolicySchema = z.object({
  seller: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid seller address'),
  amount: z.string().regex(/^\d+$/, 'amount must be a non-negative integer string'),
  timeoutSeconds: z.coerce.number().int().min(60).max(86400),
  maxRetries: z.coerce.number().int().min(1).max(10),
  chainId: z.coerce.number().int().default(677),
});

// ── POST /create-policy ─────────────────────────────────────────────────────
router.post('/create-policy', async (req, res) => {
  try {
    const privateKey = process.env.WATCHER_PRIVATE_KEY;
    
    if (!privateKey) {
      logger.error('WATCHER_PRIVATE_KEY not set in environment');
      res.status(500).json({ error: 'Server configuration error: WATCHER_PRIVATE_KEY not set' });
      return;
    }

    // Validate request body
    const parsed = createPolicySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
      return;
    }

    const { seller, amount, timeoutSeconds, maxRetries, chainId } = parsed.data;

    // Setup provider and wallet
    const provider = new ethers.JsonRpcProvider(RPC_URL, chainId);
    const wallet = new ethers.Wallet(privateKey, provider);

    logger.info({
      msg: 'M2M test: Creating policy',
      buyer: wallet.address,
      seller,
      amount,
      timeoutSeconds,
      maxRetries,
      chainId,
    });

    // Calculate premium (1% of amount)
    const amountBigInt = BigInt(amount);
    const premiumBigInt = amountBigInt / 100n; // 1% premium

    // Approve USDT spending
    const usdt = new ethers.Contract(CONTRACTS.usdt, USDT_ABI, wallet);
    const allowance = await usdt.allowance(wallet.address, CONTRACTS.insurance);

    if (allowance < premiumBigInt) {
      logger.info('Approving USDT spending...');
      const approveTx = await usdt.approve(CONTRACTS.insurance, premiumBigInt);
      await approveTx.wait();
      logger.info({ msg: 'USDT approved', txHash: approveTx.hash });
    }

    // Create policy via contract
    const insurance = new ethers.Contract(CONTRACTS.insurance, INSURANCE_ABI, wallet);
    
    const tx = await insurance.buyInsurance(
      seller,
      amountBigInt,
      timeoutSeconds,
      maxRetries,
      { value: premiumBigInt } // Premium in native token
    );

    logger.info({ msg: 'Policy creation tx sent', txHash: tx.hash });
    const receipt = await tx.wait();

    // Extract policyId from event
    let policyId: string | null = null;
    
    if (receipt && receipt.logs) {
      const policyCreatedEvent = receipt.logs.find(
        (log: any) => {
          try {
            return log.topics[0] === ethers.id('PolicyCreated(uint256,address,address,uint256,uint256,uint256)');
          } catch {
            return false;
          }
        }
      );

      if (policyCreatedEvent && policyCreatedEvent.topics[1]) {
        policyId = BigInt(policyCreatedEvent.topics[1]).toString();
      }
    }

    if (!policyId) {
      logger.error('PolicyCreated event not found in transaction logs');
      res.status(500).json({ 
        error: 'Policy creation succeeded but event not found',
        txHash: tx.hash 
      });
      return;
    }

    logger.info({
      msg: 'M2M test: Policy created successfully',
      policyId,
      txHash: tx.hash,
      buyer: wallet.address,
      seller,
    });

    res.json({
      success: true,
      policyId,
      txHash: tx.hash,
      contractAddress: CONTRACTS.insurance,
      buyer: wallet.address,
      seller,
      amount: amount,
      premium: premiumBigInt.toString(),
      timeoutSeconds,
      maxRetries,
      chainId,
    });

  } catch (error: any) {
    logger.error({
      msg: 'M2M test: Error creating policy',
      error: error.message,
      stack: error.stack,
    });
    
    res.status(500).json({ 
      error: 'Failed to create policy',
      message: error.message,
    });
  }
});

export default router;
