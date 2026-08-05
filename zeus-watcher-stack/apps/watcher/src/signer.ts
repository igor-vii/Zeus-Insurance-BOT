import { Wallet, keccak256, toUtf8Bytes } from 'ethers';

export function createSigner(privateKey: string) {
  const wallet = new Wallet(privateKey);
  
  return {
    async signVote(chainId: number, policyId: string, watcher: string, vote: boolean) {
      const timestamp = Date.now();
      const msg = `ZeusVote:${chainId}:${policyId}:${watcher}:${vote}:${timestamp}`;
      const signature = await wallet.signMessage(msg);
      return { timestamp, signature };
    }
  };
}
