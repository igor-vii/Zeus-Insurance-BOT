---
name: Non-custodial payment boundary
description: Durable architectural rule for Secretariat payment authorization and pending-signature state.
---

Secretariat production flow is non-custodial by default. Request creation may discover policy, reserve and persist the payment binding, nonce, authorizer, and validity window, but must not access a signer, create a signature, submit to a facilitator, or mark payment authorized.

**Why:** The server must not hold or use a user's private key, and an unsigned payment must not enter submission or reconciliation as if it were already submitted.

**How to apply:** Keep pre-signature intents in `PENDING_SIGNATURE` and pre-signature operations in `AWAITING_SIGNATURE`. Accept only an externally signed payload whose economic and nonce fields exactly match the persisted intent; only then continue the existing authorization, submission, and settlement path. Custodial signing must remain an explicit test-only mode.