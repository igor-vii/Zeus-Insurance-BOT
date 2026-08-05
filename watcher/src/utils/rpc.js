export async function rpcCall(rpcUrl, method, params, id = 1) {
  const resp = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id }),
  });
  if (!resp.ok) throw new Error(`RPC HTTP ${resp.status}`);
  const json = await resp.json();
  if (json.error) throw new Error(`RPC error: ${json.error.message}`);
  return json.result;
}

export async function ethCall(rpcUrl, to, data) {
  return rpcCall(rpcUrl, 'eth_call', [{ to, data }, 'latest']);
}
