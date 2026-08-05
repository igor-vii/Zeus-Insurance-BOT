export function decodeUint256(hex, offset = 0) {
  return BigInt('0x' + hex.slice(2 + offset * 64, 2 + (offset + 1) * 64));
}

export function decodeAddress(hex, offset = 0) {
  return '0x' + hex.slice(2 + offset * 64 + 24, 2 + (offset + 1) * 64).toLowerCase();
}

export function encodeUint256(value) {
  return BigInt(value).toString(16).padStart(64, '0');
}
