import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

dotenv.config();

const PRIVATE_KEY = process.env.PRIVATE_KEY ?? "";
const BASE_SEPOLIA_RPC_URL =
  process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org";
const BASE_MAINNET_RPC_URL =
  process.env.BASE_MAINNET_RPC_URL ?? "https://mainnet.base.org";
const XLAYER_MAINNET_RPC_URL =
  process.env.XLAYER_MAINNET_RPC_URL ?? "https://rpc.xlayer.tech";
const XLAYER_TESTNET_RPC_URL =
  process.env.XLAYER_TESTNET_RPC_URL ?? "https://testrpc.xlayer.tech";
const BASESCAN_API_KEY =
  process.env.ETHERSCAN_API_KEY ?? process.env.BASESCAN_API_KEY ?? "";
const OKLINK_API_KEY = process.env.OKLINK_API_KEY ?? "";
const BOT_CHAIN_RPC_URL =
  process.env.BOT_CHAIN_RPC_URL ?? "https://rpc.botanixlabs.com";
const BOT_CHAIN_TESTNET_RPC_URL =
  process.env.BOT_CHAIN_TESTNET_RPC_URL ?? "https://node.botanixlabs.dev";

const config: HardhatUserConfig = {
  solidity: {
    compilers: [
      {
        version: "0.8.27",
        settings: {
          optimizer: { enabled: true, runs: 200 },
          evmVersion: "cancun",   // required for OZ 5.x (mcopy opcode)
        },
      },
      {
        // ZeusEscrowBOT.sol — pinned to 0.8.24 for BOT Chain compatibility
        version: "0.8.24",
        settings: {
          optimizer: { enabled: true, runs: 200 },
          evmVersion: "cancun",   // required for OZ 5.x (mcopy opcode)
        },
      },
    ],
  },
  networks: {
    hardhat: {},
    "base-sepolia": {
      url: BASE_SEPOLIA_RPC_URL,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
      chainId: 84532,
    },
    "base-mainnet": {
      url: BASE_MAINNET_RPC_URL,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
      chainId: 8453,
    },
    xlayer: {
      url: XLAYER_MAINNET_RPC_URL,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
      chainId: 196,
    },
    "xlayer-testnet": {
      url: XLAYER_TESTNET_RPC_URL,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
      chainId: 195,
    },
    "bot-chain": {
      url: BOT_CHAIN_RPC_URL,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
      chainId: 3637,
    },
    "bot-chain-testnet": {
      url: BOT_CHAIN_TESTNET_RPC_URL,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
      chainId: 968,
    },
  },
  etherscan: {
    // Etherscan V2 unified API — requires an etherscan.io key (not basescan.org)
    // For X Layer contracts, set OKLINK_API_KEY from https://www.oklink.com/account/my-api
    apiKey: {
      "base-sepolia": BASESCAN_API_KEY,
      "base-mainnet": BASESCAN_API_KEY,
      xlayer: OKLINK_API_KEY,
      "xlayer-testnet": OKLINK_API_KEY,
      "bot-chain": OKLINK_API_KEY,
      "bot-chain-testnet": OKLINK_API_KEY,
    },
    customChains: [
      {
        network: "base-sepolia",
        chainId: 84532,
        urls: {
          apiURL: "https://api.etherscan.io/v2/api?chainid=84532",
          browserURL: "https://sepolia.basescan.org",
        },
      },
      {
        network: "base-mainnet",
        chainId: 8453,
        urls: {
          apiURL: "https://api.etherscan.io/v2/api?chainid=8453",
          browserURL: "https://basescan.org",
        },
      },
      {
        network: "xlayer",
        chainId: 196,
        urls: {
          apiURL: "https://www.oklink.com/api/v5/explorer/contract/verify-source-code-plugin/XLAYER",
          browserURL: "https://www.oklink.com/xlayer",
        },
      },
      {
        network: "xlayer-testnet",
        chainId: 195,
        urls: {
          apiURL: "https://www.oklink.com/api/v5/explorer/contract/verify-source-code-plugin/XLAYER_TEST",
          browserURL: "https://www.oklink.com/xlayer-test",
        },
      },
          {
        network: "bot-chain",
        chainId: 3637,
        urls: {
          apiURL: "https://blockscout.botanixlabs.com/api",
          browserURL: "https://blockscout.botanixlabs.com",
        },
      },
      {
        network: "bot-chain-testnet",
        chainId: 968,
        urls: {
          apiURL: "https://testnet.blockscout.botanixlabs.com/api",
          browserURL: "https://testnet.blockscout.botanixlabs.com",
        },
      },
    ],
  },
  paths: {
    sources: "./src",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  typechain: {
    outDir: "typechain-types",
    target: "ethers-v6",
  },
};

export default config;
