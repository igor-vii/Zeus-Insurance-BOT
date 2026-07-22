---
name: SDK ESM build requirement
description: The @zeus/sdk workspace package must compile to ESM or Vite will fail to load it
---

## Rule
`sdk/tsconfig.json` must use `"module": "NodeNext"` and `"moduleResolution": "NodeNext"`. `sdk/package.json` must have `"type": "module"` and an `"exports"` field pointing to the ESM dist.

**Why:** Vite treats workspace packages (`workspace:*` deps) as first-party source — they bypass `optimizeDeps` and are NOT converted from CJS to ESM. If the SDK dist is CJS (`exports.ZeusSDK = …`), the browser throws `SyntaxError: does not provide an export named 'ZeusSDK'`.

**How to apply:** Any time the SDK's tsconfig or package.json is touched, verify it still has `"type": "module"` and `"module": "NodeNext"`. After any SDK source change, run `pnpm build` in `sdk/` and restart the Frontend workflow.

## Side-note on imports
The SDK source files already use `.js` extension on all relative imports (required for NodeNext ESM). This must be maintained for all new SDK source files.
