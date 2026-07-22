import type { Signer, Provider, ContractRunner } from "ethers";
import { type NetworkConfig } from "../types/index.js";
export declare class ZeusClient {
    private _signer;
    private _provider;
    private _network;
    private _address;
    /**
     * Connect to a network with a signer.
     * @param network  One of "mainnet" | "base-sepolia" | "sepolia" | "localhost"
     * @param signer   ethers v6 Signer (wallet, injected provider, etc.)
     */
    connect(network: string, signer: Signer): Promise<void>;
    isReady(): boolean;
    getAddress(): string;
    getNetwork(): NetworkConfig;
    getSigner(): Signer;
    getProvider(): Provider | null;
    getRunner(): ContractRunner;
    disconnect(): void;
}
//# sourceMappingURL=client.d.ts.map