import { signTypedData } from 'viem';
const RID = process.argv[2];
const status = await (await fetch(`http://127.0.0.1:3090/v1/requests/${RID}`)).json();
const pr = status.paymentRequired;
// deterministically derive a payer key (test-only)
const pk = '0x4646464646464646464646464646464646464646464646464646464646464646';
const nonce = '0x' + Buffer.from(RID).toString('hex').padEnd(64,'0').slice(0,64);
const nowSec = Math.floor(Date.now()/1000);
const message = {
  from: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', // well-known anvil key #0 matches pk above
  to: pr.payee,
  value: pr.amount,
  validAfter: String(nowSec - 60),
  validBefore: String(nowSec + 3600),
  nonce,
};
const signature = await signTypedData({
  account: pk, chainId: 84532,
  domain: { name: 'USD Coin', version: '2', chainId: 84532, verifyingContract: pr.asset },
  types: { TransferWithAuthorization: [
    {name:'from',type:'address'},{name:'to',type:'address'},{name:'value',type:'uint256'},
    {name:'validAfter',type:'uint256'},{name:'validBefore',type:'uint256'},{name:'nonce',type:'bytes32'}]},
  primaryType: 'TransferWithAuthorization', message,
});
const payload = { x402Version: 2, scheme: 'exact', network: pr.network, payload: { authorization: {...message}, signature } };
console.log('payload:', JSON.stringify(payload).slice(0,300));
const res = await fetch(`http://127.0.0.1:3090/v1/requests/${RID}/payment`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload)});
console.log('HTTP', res.status);
console.log(await res.text());
