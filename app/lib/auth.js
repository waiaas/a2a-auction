/**
 * 연결 시점 신원 증명 (nonce 챌린지 + Ed25519 서명 검증).
 *
 * **주소만 받으면 신원이 아니다.** 지갑 주소는 공개 정보라 남의 주소를 그대로 보내면 그 사람의
 * 에이전트 지갑을 조작할 수 있다. 그래서 서버가 매번 새 nonce를 내고, 그 nonce가 든 메시지에
 * 대한 서명을 받아 **개인키 보유**를 확인한 뒤에야 토큰을 발급한다.
 *
 * 검증은 Node 내장 crypto로 한다. Solana 공개키는 raw 32바이트라 SPKI DER 머리를 붙여야
 * `createPublicKey`가 Ed25519 키로 받아들인다(외부 라이브러리 없이 처리하는 표준 방법).
 */
import crypto from 'node:crypto';
import { PublicKey } from './solana.js';

/** Ed25519 SPKI DER 헤더. 뒤에 raw 공개키 32바이트를 붙이면 완전한 SPKI가 된다. */
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** nonce 유효 시간. 지갑 팝업을 읽고 누르는 시간을 넉넉히 잡되 무한정 열어 두지 않는다. */
const NONCE_TTL_MS = 5 * 60 * 1000;

/** address → { nonce, expiresAt }. 서버 재시작 시 사라지지만 재연결하면 그만이다. */
const nonces = new Map();

/** 만료된 것만 걷어낸다. 발급 때마다 호출해 별도 타이머를 두지 않는다. */
function sweep() {
  const now = Date.now();
  for (const [addr, v] of nonces) if (v.expiresAt < now) nonces.delete(addr);
}

/**
 * 연결 챌린지 발급. 사용자가 지갑 팝업에서 **읽고 판단할 수 있는 문구**여야 하므로
 * 무엇에 서명하는지를 한국어로 적는다(의미 불명의 hex를 서명하게 하는 것이 피싱의 형태다).
 */
export function issueNonce(ownerAddress) {
  assertAddress(ownerAddress);
  sweep();
  const nonce = crypto.randomBytes(16).toString('hex');
  nonces.set(ownerAddress, { nonce, expiresAt: Date.now() + NONCE_TTL_MS });
  const message =
    'A2AHouse에 지갑을 연결합니다.\n\n' +
    `지갑 주소: ${ownerAddress}\n` +
    `일회용 코드: ${nonce}\n\n` +
    '이 서명은 본인 확인에만 쓰이며 자금이 움직이지 않습니다.';
  return { nonce, message, expiresInSec: NONCE_TTL_MS / 1000 };
}

/**
 * 서명 검증 후 nonce를 소비한다(1회용).
 *
 * 검증 대상은 세 가지다. ① 발급한 nonce가 맞는지 ② 만료되지 않았는지 ③ 서명이 그 주소의
 * 개인키에서 나왔는지. 하나라도 빠지면 재사용 공격이나 사칭이 열린다.
 */
export function verifyConnect(ownerAddress, message, signatureB64) {
  const entry = nonces.get(ownerAddress);
  if (!entry) throw new Error('연결 코드가 없습니다. 다시 연결해 주세요.');
  if (entry.expiresAt < Date.now()) {
    nonces.delete(ownerAddress);
    throw new Error('연결 코드가 만료됐습니다. 다시 연결해 주세요.');
  }
  if (!message.includes(entry.nonce)) throw new Error('연결 코드가 일치하지 않습니다.');
  if (!verifySignature(ownerAddress, message, signatureB64)) {
    throw new Error('서명이 이 지갑 주소와 맞지 않습니다.');
  }
  nonces.delete(ownerAddress); // 1회용 — 같은 서명을 다시 쓰지 못하게 한다
  return true;
}

/**
 * Ed25519 서명 검증.
 *
 * @param {string} ownerAddress - base58 Solana 주소
 * @param {string} message - 서명 원문(UTF-8)
 * @param {string} signatureB64 - base64 서명 64바이트
 */
export function verifySignature(ownerAddress, message, signatureB64) {
  try {
    const raw = new PublicKey(ownerAddress).toBytes();
    const key = crypto.createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, Buffer.from(raw)]),
      format: 'der',
      type: 'spki',
    });
    return crypto.verify(null, Buffer.from(message, 'utf8'), key, Buffer.from(signatureB64, 'base64'));
  } catch {
    return false; // 주소·서명 형식 오류도 검증 실패로 접는다
  }
}

/** base58 Solana 주소인지. 형식이 틀리면 아래 단계가 이해하기 어려운 오류를 낸다. */
export function assertAddress(address) {
  try {
    new PublicKey(address);
  } catch {
    throw new Error('올바른 Solana 지갑 주소가 아닙니다.');
  }
}

/** 인증 토큰 발급(서명 검증 통과 후에만). */
export function newAuthToken() {
  return crypto.randomBytes(32).toString('base64url');
}
