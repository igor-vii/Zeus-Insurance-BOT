import { useCallback } from 'react';
import { useAccount, useChainId, useWriteContract } from 'wagmi';
import { parseUnits } from 'viem';
import { getInsuranceAddress, getTokenAddress } from '@/lib/contracts';
import { fetchSlashingPremium } from '@/lib/api-client';

interface BuySlashingParams {
  validator: `0x${string}`;
  amount: number;
  timeoutDays: number;
}

export function useSlashing() {
  const { address } = useAccount();
  const chainId = useChainId();
  const { writeContract, isPending, isSuccess, isError, error, data: txHash } = useWriteContract();

  const buySlashingProtection = useCallback(async (params: BuySlashingParams) => {
    if (!address) throw new Error('Wallet not connected');

    const insuranceAddress = getContracts(chainId).insurance;
    const tokenAddress = getContracts(chainId).token;
    const amountBigInt = parseUnits(params.amount.toString(), 6);

    // Fetch premium from API — single source of truth for rate calculation
    const { premium } = await fetchSlashingPremium({
      validator: params.validator,
      amount: params.amount,
      chainId,
    });
    const premiumBigInt = parseUnits(premium.toFixed(6), 6);

    // 1. Approve token spend
    await writeContract({
      address: tokenAddress,
      abi: [{
        name: 'approve',
        type: 'function',
        inputs: [
          { name: 'spender', type: 'address' },
          { name: 'amount',  type: 'uint256' },
        ],
        outputs: [{ name: '', type: 'bool' }],
        stateMutability: 'nonpayable',
      }],
      functionName: 'approve',
      args: [insuranceAddress, premiumBigInt],
    });

    // 2. Purchase slashing protection
    return writeContract({
      address: insuranceAddress,
      abi: [{
        name: 'buySlashingProtection',
        type: 'function',
        inputs: [
          { name: 'validator',       type: 'address' },
          { name: 'amount',          type: 'uint256' },
          { name: 'timeoutSeconds',  type: 'uint256' },
        ],
        outputs: [{ name: 'policyId', type: 'uint256' }],
        stateMutability: 'nonpayable',
      }],
      functionName: 'buySlashingProtection',
      args: [
        params.validator,
        amountBigInt,
        BigInt(params.timeoutDays * 86400),
      ],
    });
  }, [address, chainId, writeContract]);

  return { buySlashingProtection, isPending, isSuccess, isError, error, txHash };
}
