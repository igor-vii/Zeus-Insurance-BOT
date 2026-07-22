---
name: BaseScan verification
description: How to verify contracts on Base Sepolia via Hardhat — BaseScan V1 is dead, Etherscan V2 required.
---

# BaseScan contract verification

## Rule
Use the Etherscan V2 unified API with a plain string `apiKey` from **etherscan.io** (not basescan.org).

```ts
etherscan: {
  apiKey: BASESCAN_API_KEY, // etherscan.io key, stored as BASESCAN_API_KEY secret
  customChains: [{
    network: "base-sepolia",
    chainId: 84532,
    urls: {
      apiURL: "https://api.etherscan.io/v2/api?chainid=84532",
      browserURL: "https://sepolia.basescan.org",
    },
  }],
},
```

**Why:** BaseScan's own endpoint (`api-sepolia.basescan.org/api`) returns a hard error ("deprecated V1 endpoint") as of mid-2026. The per-network `apiKey` object format also triggers the deprecation warning. Etherscan V2 is the only working path, and it requires an etherscan.io key — a basescan.org key returns "Invalid API Key (#err2)".

**How to apply:** Whenever adding or updating Hardhat verify config for any Base network, always use the V2 URL and a single string `apiKey`. Direct users to https://etherscan.io/myapikey if they need to create a key.
