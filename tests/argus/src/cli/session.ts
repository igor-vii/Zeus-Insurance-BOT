#!/usr/bin/env node

/**
 * Argus Session CLI — Mode A MVP vertical slice.
 *
 * Usage:
 *   npx tsx src/cli/session.ts create --mode BUYER --profile x402-buyer-basic
 *   npx tsx src/cli/session.ts status <sessionId>
 *   npx tsx src/cli/session.ts result <sessionId>
 *   npx tsx src/cli/session.ts serve
 *
 * Mode A is in-memory and process-local. A session and its ephemeral seller
 * endpoint therefore live only for the lifetime of this CLI process.
 */

import { X402SellerAdapter } from '../adapters/seller/X402SellerAdapter';
import { SessionManager } from '../sessions/SessionManager';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) {
    console.log('Usage:');
    console.log('  session create --mode BUYER --profile <name>');
    console.log('  session status <sessionId>');
    console.log('  session result <sessionId>');
    console.log('  session serve');
    process.exit(1);
  }

  const sellerAdapter = new X402SellerAdapter();
  const manager = new SessionManager(sellerAdapter);

  try {
    switch (command) {
      case 'create': {
        const modeIdx = args.indexOf('--mode');
        const profileIdx = args.indexOf('--profile');
        const timeoutIdx = args.indexOf('--timeout');

        const mode = modeIdx >= 0 ? args[modeIdx + 1] : 'BUYER';
        const profile = profileIdx >= 0 ? args[profileIdx + 1] : 'x402-buyer-basic';
        const timeout = timeoutIdx >= 0 ? Number.parseInt(args[timeoutIdx + 1], 10) : 60;

        if (mode !== 'BUYER' && mode !== 'SELLER') {
          console.error(`Error: Invalid mode '${mode}'. Must be BUYER or SELLER.`);
          process.exit(1);
        }

        const session = manager.createSession({
          testMode: mode as 'BUYER' | 'SELLER',
          testProfile: profile,
          timeoutSeconds: timeout,
        });

        const endpoint = await sellerAdapter.start(session.getEndpointPath());
        manager.setBaseUrl(new URL(endpoint).origin);

        console.log(JSON.stringify({
          session_id: session.session_id,
          test_mode: session.test_mode,
          test_profile: session.test_profile,
          session_endpoint: endpoint,
          expires_at: new Date(session.expires_at).toISOString(),
          status: session.status,
        }, null, 2));

        console.error('[session] Server running. Press Ctrl+C to stop.');
        await new Promise<void>(() => {});
        break;
      }

      case 'status': {
        const sessionId = args[1];
        if (!sessionId) {
          console.error('Error: Session ID required');
          process.exit(1);
        }

        const session = manager.getSession(sessionId);
        if (!session) {
          console.error(`Error: Unknown session '${sessionId}' (sessions are process-local)`);
          process.exit(1);
        }

        manager.checkExpiry(sessionId);

        console.log(JSON.stringify({
          session_id: session.session_id,
          status: session.status,
          interaction_count: session.interactionCount,
          created_at: new Date(session.created_at).toISOString(),
          expires_at: new Date(session.expires_at).toISOString(),
        }, null, 2));
        break;
      }

      case 'result': {
        // Block A boundary: the session layer owns NO verdict. Semantic
        // evaluation for inbound scenarios lives exclusively in the
        // canonical pipeline (argus run S9 → EvidenceCollector →
        // AssertionEngine → RunResult.verdict). This command reports
        // transport/lifecycle state only.
        const sessionId = args[1];
        if (!sessionId) {
          console.error('Error: Session ID required');
          process.exit(1);
        }

        const session = manager.getSession(sessionId);
        if (!session) {
          console.error(`Error: Unknown session '${sessionId}' (sessions are process-local)`);
          process.exit(1);
        }

        manager.checkExpiry(sessionId);
        console.log(JSON.stringify({
          session_id: session.session_id,
          status: session.status,
          interaction_count: session.interactionCount,
          note: 'verdicts are produced by `argus run S9` (canonical EvidenceCollector → AssertionEngine pipeline)',
        }, null, 2));
        break;
      }

      case 'serve': {
        const session = manager.createSession({
          testMode: 'BUYER',
          testProfile: 'x402-buyer-basic',
        });
        const endpoint = await sellerAdapter.start(session.getEndpointPath());
        manager.setBaseUrl(new URL(endpoint).origin);

        console.log(JSON.stringify({
          status: 'running',
          session_id: session.session_id,
          session_endpoint: endpoint,
        }, null, 2));
        console.error('[session] Server running. Press Ctrl+C to stop.');
        await new Promise<void>(() => {});
        break;
      }

      default:
        console.error(`Error: Unknown command '${command}'`);
        process.exit(1);
    }
  } catch (error) {
    console.error('Fatal error:', error instanceof Error ? error.message : 'Unknown error');
    await sellerAdapter.stop();
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
