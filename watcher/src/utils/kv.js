export async function getOffset(env, key) {
  const val = await env.ZEUS_KV.get(key);
  return parseInt(val || '0', 10);
}

export async function setOffset(env, key, value) {
  await env.ZEUS_KV.put(key, value.toString());
}
