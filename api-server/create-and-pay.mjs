import { privateKeyToAccount, signTypedData } from 'viem/accounts';

const SK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d964f578070';
const account = privateKeyToAccount(SK);
const BASE = 'http://127.0.0.1:3090/v1/requests';

// 1. Create request (fresh intent -> fresh validBefore window)
const createBody = {
  authorizer: account.address,
  target: 'http://127.0.0.1:3099/task',
  method: 'POST',
  payload: { q: 'argus-e2e' },
  policy: { maxPrice: '1000', allowedNetworks: ['base-sepolia'], allowedAssets: ['0x036CbD53842c5426634e7929541eC2318f3dCF7e'], authorizationMode: 'explicit' },
};
const r1 = await fetch(BASE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(createBody) });
const j1 = await r1.json();
console.log('CREATE status:', r1.status, JSON.stringify(j1).slice(0,400));
const pr = j1.paymentRequired ?? j1.payment;
console.log('paymentRequired:', JSON.stringify(pr));

const requestId = j1.requestId;

// 2. Fetch persisted context via GET (public view may not expose nonce; read challenge from paymentRequired)
// The verifier binds to the PERSISTED intent values: network='base-sepolia', asset, amount='1000', payTo, nonce, validAfter, validBefore.
// Nonce/validAfter/validBefore are server-generated; we must read them from DB (test sandbox).
import { execSync } from 'node:child_process';
const row = execSync(`psql -h localhost -U postgres -d zeus_test -tAc "select nonce, valid_after, valid_before, regexp_replace(value::text, '\\.0+$', ''), network, asset, pay_to from payment_intents where request_id='${requestId}'"`).toString().trim();
const [nonce, validAfter, validBefore, value, network, asset, payTo] = row.split('|');
console.log('DB intent:', { nonce, validAfter, validBefore, value, network, asset, payTo });

// 3. Build x402 V2 payload with EIP-3009 signature over EXACT persisted values
const intVal = value.replace(/\.?0+$/, '');
const authorization = {
  from: account.address,
  to: payTo,
  value: intVal,
  validAfter,
  validBefore,
  nonce,
};
const domain = { name: 'USD Coin', version: '2', chainId: 84532, verifyingContract: asset };
const types = { TransferWithAuthorization: [
  { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
  { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
  { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
]};
const signature = await account.signTypedData({ domain, types, primaryType: 'TransferWithAuthorization', message: authorization });

const payload = {
  x402Version: 2,
  accepted: { scheme: 'exact', network, amount: value, asset, payTo },
  payload: { authorization, signature },
};
const r2 = await fetch(`${BASE}/${requestId}/payment`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
const j2 = await r2.json();
console.log('PAYMENT status:', r2.status, JSON.stringify(j2).slice(0, 800));

// 4. Poll status
for (let i = 0; i < 10; i++) {
  await new Promise(res => setTimeout(res, 1500));
  const r3 = await fetch(`${BASE}/${requestId}`);
  const j3 = await r3.json();
  console.log(`POLL ${i}:`, r3.status, JSON.stringify(j3).slice(0, 500));
  if (['COMPLETED','FAILED','UNRESOLVABLE'].includes(j3.status)) break;
}
