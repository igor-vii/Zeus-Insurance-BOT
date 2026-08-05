import { ethers } from 'ethers';

const ABI = [
  'function policies(uint256) view returns (address,address,uint256,uint256,uint256,uint256,bool,bool,bool)',
  'function claimPayout(uint256) payable',
];

export function getProvider(rpcs: string[]) {
  return new ethers.FallbackProvider(rpcs.map(url => new ethers.JsonRpcProvider(url)));
}

export function getContract(address: string, provider: ethers.Provider) {
  return new ethers.Contract(address, ABI, provider);
}
