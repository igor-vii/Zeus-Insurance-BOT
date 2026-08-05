"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ObservationSigner = void 0;
const ethers_1 = require("ethers");
function hexToBytes(hex) {
    hex = hex.replace(/^0x/, '');
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return bytes;
}
function concatBytes(a, b) {
    const res = new Uint8Array(a.length + b.length);
    res.set(a, 0);
    res.set(b, a.length);
    return res;
}
class ObservationSigner {
    key;
    constructor(privateKeyHex) {
        this.key = new ethers_1.SigningKey(privateKeyHex);
    }
    /**
     * Формирует Observation согласно ZeusInsuranceV2.submitObservation
     * requestId = keccak256(abi.encodePacked(buyer, seller, timestamp))
     */
    async signObservation(params) {
        const { buyer, seller, timestamp, status, metadataHash, nonce } = params;
        // requestId как в контракте
        const requestId = (0, ethers_1.keccak256)(new ethers_1.AbiCoder().encode(['address', 'address', 'uint256'], [buyer, seller, timestamp]));
        const meta = metadataHash || '0x0000000000000000000000000000000000000000000000000000000000000000';
        const n = nonce ?? 0;
        // msgHash = keccak256(abi.encodePacked(requestId, timestamp, status, metadataHash, nonce))
        const packed = concatBytes(concatBytes(concatBytes(concatBytes(hexToBytes(requestId), hexToBytes('0x' + BigInt(timestamp).toString(16).padStart(64, '0'))), hexToBytes('0x' + status.toString(16).padStart(2, '0'))), hexToBytes(meta)), hexToBytes('0x' + BigInt(n).toString(16).padStart(64, '0')));
        const msgHash = (0, ethers_1.keccak256)(packed);
        const ethPrefix = (0, ethers_1.toUtf8Bytes)('\x19Ethereum Signed Message:\n32');
        const ethMsg = concatBytes(ethPrefix, hexToBytes(msgHash));
        const ethHash = (0, ethers_1.keccak256)(ethMsg);
        const sig = this.key.sign(ethHash);
        const r = sig.r.slice(2).padStart(64, '0');
        const s = sig.s.slice(2).padStart(64, '0');
        const v = (sig.v).toString(16).padStart(2, '0');
        return {
            requestId,
            timestamp,
            status,
            metadataHash: meta,
            nonce: n,
            signature: '0x' + r + s + v,
        };
    }
}
exports.ObservationSigner = ObservationSigner;
