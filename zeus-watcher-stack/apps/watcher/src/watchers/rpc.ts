import { NetworkConfig } from '@zeus/shared';
import { JsonRpcProvider } from 'ethers';

export async function checkRpcHealth(cfg: NetworkConfig): Promise<boolean> {
  try {
    const provider = new JsonRpcProvider(cfg.rpcs[0]);
    const blockNumber = await Promise.race([
      provider.getBlockNumber(),
      new Promise<never>((_, reject) => 
        setTimeout(() => reject(new Error('RPC timeout')), 5000)
      )
    ]);
    return blockNumber > 0;
  } catch (err) {
    return false;
  }
}
