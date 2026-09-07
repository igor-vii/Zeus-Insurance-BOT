---
name: Non-custodial payment boundary
description: Durable architectural rule for Secretariat payment authorization and pending-signature state.
---

Secretariat production flow is non-custodial by default. Request creation may discover policy, reserve and persist the payment binding, nonce, authorizer, and validity window, but must not access a signer, create a signature, submit to a facilitator, or mark payment authorized.

**Why:** The server must not hold or use a user's private key, and an unsigned payment must not enter submission or reconciliation as if it were already submitted.

**How to apply:** Keep pre-signature intents in `PENDING_SIGNATURE` and pre-signature operations in `AWAITING_SIGNATURE`. Accept only an externally signed payload whose economic and nonce fields exactly match the persisted intent; only then continue the existing authorization, submission, and settlement path. Custodial signing must remain an explicit test-only mode.

When a legacy signer continuation reuses the shared Stage-A preparation, persist the operation immediately after authorization and before submission.

**Why:** Otherwise a retry can reconstruct an operation still marked `AWAITING_SIGNATURE` after a payment was already submitted and repeat the economic action.

**How to apply:** Treat the operation persistence after authorization as part of the continuation boundary; do not rely only on the pre-signature persistence or final settlement persistence.