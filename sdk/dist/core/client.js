import { JsonRpcProvider } from "ethers";
import { NETWORKS, ZeusError, ZeusNotConnectedError, ZeusValidationError, } from "../types/index.js";
export class ZeusClient {
    _signer = null;
    _provider = null;
    _network = null;
    _address = null;
    /**
     * Connect to a network with a signer.
     * @param network  One of "mainnet" | "base-sepolia" | "sepolia" | "localhost"
     * @param signer   ethers v6 Signer (wallet, injected provider, etc.)
     */
    async connect(network, signer) {
        if (!(network in NETWORKS)) {
            throw new ZeusValidationError(`Unknown network "${network}". Supported networks: ${Object.keys(NETWORKS).join(", ")}`);
        }
        const networkConfig = NETWORKS[network];
        if (!signer || typeof signer.getAddress !== "function") {
            throw new ZeusValidationError("Invalid signer: must be an ethers v6 Signer with a getAddress() method.");
        }
        const provider = signer.provider
            ? signer.provider
            : networkConfig.rpcUrl
                ? new JsonRpcProvider(networkConfig.rpcUrl)
                : null;
        if (signer.provider) {
            try {
                const { chainId: walletChainId } = await signer.provider.getNetwork();
                if (Number(walletChainId) !== networkConfig.chainId) {
                    throw new ZeusValidationError(`Network mismatch: wallet is connected to chain ${walletChainId}, but SDK is configured for chain ${networkConfig.chainId} (${networkConfig.name}). Please switch your wallet to ${networkConfig.name}.`);
                }
            }
            catch (err) {
                if (err instanceof ZeusValidationError)
                    throw err;
                throw new ZeusError(`Failed to verify wallet network: ${err.message}`, "SIGNER_ERROR", err);
            }
        }
        let address;
        try {
            address = await signer.getAddress();
        }
        catch (err) {
            throw new ZeusError(`Failed to retrieve address from signer: ${err.message}`, "SIGNER_ERROR", err);
        }
        this._network = networkConfig;
        this._signer = signer;
        this._provider = provider;
        this._address = address;
    }
    isReady() {
        return this._signer !== null && this._network !== null && this._address !== null;
    }
    getAddress() {
        if (!this._address)
            throw new ZeusNotConnectedError();
        return this._address;
    }
    getNetwork() {
        if (!this._network)
            throw new ZeusNotConnectedError();
        return this._network;
    }
    getSigner() {
        if (!this._signer)
            throw new ZeusNotConnectedError();
        return this._signer;
    }
    getProvider() {
        return this._provider;
    }
    getRunner() {
        if (!this._signer)
            throw new ZeusNotConnectedError();
        return this._signer;
    }
    disconnect() {
        this._signer = null;
        this._provider = null;
        this._network = null;
        this._address = null;
    }
}
//# sourceMappingURL=client.js.map