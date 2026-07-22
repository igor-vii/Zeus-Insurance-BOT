import { JsonRpcProvider } from "ethers";
import type { Signer, Provider, ContractRunner } from "ethers";
import {
  NETWORKS,
  type Network,
  type NetworkConfig,
  ZeusError,
  ZeusNotConnectedError,
  ZeusValidationError,
} from "../types/index.js";

export class ZeusClient {
  private _signer: Signer | null = null;
  private _provider: Provider | null = null;
  private _network: NetworkConfig | null = null;
  private _address: string | null = null;

  /**
   * Connect to a network with a signer.
   * @param network  One of "mainnet" | "base-sepolia" | "sepolia" | "localhost"
   * @param signer   ethers v6 Signer (wallet, injected provider, etc.)
   */
  async connect(network: string, signer: Signer): Promise<void> {
    if (!(network in NETWORKS)) {
      throw new ZeusValidationError(
        `Unknown network "${network}". Supported networks: ${Object.keys(NETWORKS).join(", ")}`,
      );
    }
    const networkConfig = NETWORKS[network as Network];

    if (!signer || typeof signer.getAddress !== "function") {
      throw new ZeusValidationError(
        "Invalid signer: must be an ethers v6 Signer with a getAddress() method.",
      );
    }

    const provider: Provider | null = signer.provider
      ? signer.provider
      : networkConfig.rpcUrl
        ? new JsonRpcProvider(networkConfig.rpcUrl)
        : null;

    if (signer.provider) {
      try {
        const { chainId: walletChainId } = await signer.provider.getNetwork();
        if (Number(walletChainId) !== networkConfig.chainId) {
          throw new ZeusValidationError(
            `Network mismatch: wallet is connected to chain ${walletChainId}, but SDK is configured for chain ${networkConfig.chainId} (${networkConfig.name}). Please switch your wallet to ${networkConfig.name}.`,
          );
        }
      } catch (err) {
        if (err instanceof ZeusValidationError) throw err;
        throw new ZeusError(
          `Failed to verify wallet network: ${(err as Error).message}`,
          "SIGNER_ERROR",
          err,
        );
      }
    }

    let address: string;
    try {
      address = await signer.getAddress();
    } catch (err) {
      throw new ZeusError(
        `Failed to retrieve address from signer: ${(err as Error).message}`,
        "SIGNER_ERROR",
        err,
      );
    }

    this._network = networkConfig;
    this._signer = signer;
    this._provider = provider;
    this._address = address;
  }

  isReady(): boolean {
    return this._signer !== null && this._network !== null && this._address !== null;
  }

  getAddress(): string {
    if (!this._address) throw new ZeusNotConnectedError();
    return this._address;
  }

  getNetwork(): NetworkConfig {
    if (!this._network) throw new ZeusNotConnectedError();
    return this._network;
  }

  getSigner(): Signer {
    if (!this._signer) throw new ZeusNotConnectedError();
    return this._signer;
  }

  getProvider(): Provider | null {
    return this._provider;
  }

  getRunner(): ContractRunner {
    if (!this._signer) throw new ZeusNotConnectedError();
    return this._signer as unknown as ContractRunner;
  }

  disconnect(): void {
    this._signer = null;
    this._provider = null;
    this._network = null;
    this._address = null;
  }
}
