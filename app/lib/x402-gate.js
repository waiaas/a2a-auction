/**
 * x402 결과물 unlock 게이트 — seller(수취) 측 구현.
 *
 * 지불자 측은 WAIaaS 데몬에 이미 있다(`POST /v1/x402/fetch`). 여기서 만드는 것은 두 가지다:
 *   1) 402 PaymentRequired 제시 (@x402/core v2 스키마)
 *   2) facilitator — 데몬이 부분 서명한 TransferChecked tx를 검증하고 feePayer로 공동 서명해
 *      체인에 제출·확정한다. Solana x402 스킴은 지불자가 tx를 조립하고 수취자가 수수료를
 *      대납하는 구조라서 이 역할이 반드시 수취자 쪽에 있어야 한다.
 *
 * facilitator 키는 **수수료 대납용 인프라 키**다. seller 에이전트의 지갑 키는 데몬 안에 있고
 * 이 프로세스는 그것을 갖지 않는다.
 *
 * 검증 범위: "우리에게 정확한 금액이 들어오는가"만 본다. 호출자 신원은 확인하지 않는다 —
 * 결제한 자에게 열리는 것이고 낙찰자에게만 열리는 것이 아니다(스펙 비목표 ②).
 */
import fs from 'node:fs';
import path from 'node:path';
import { VersionedTransaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  CAIP2,
  PATHS,
  USDC_DECIMALS,
  X402_AMOUNT_BASE,
  X402_MAX_TIMEOUT_SECONDS,
} from '../config.js';
import { Keypair } from './solana.js';

/** SPL Token 명령 태그. TransferChecked = 12 (data: [12, amount u64le, decimals u8]). */
const IX_TRANSFER_CHECKED = 12;
const TRANSFER_CHECKED_DATA_LEN = 10;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 402 응답 body (@x402/core v2 `PaymentRequiredV2Schema`).
 *
 * 필수 필드 주의: 최상위 `resource.url`(비어 있으면 안 됨)과 항목별 `maxTimeoutSeconds`.
 * `asset`은 CAIP-19가 아니라 **mint base58 raw**다(데몬이 `address(asset)`로 파싱한다).
 */
export function buildPaymentRequired({ resourceUrl, payTo, mint, feePayer, error = undefined }) {
  const body = {
    x402Version: 2,
    resource: {
      url: resourceUrl,
      description: '낙찰 결과물 unlock (1회 열람)',
      mimeType: 'application/json',
    },
    accepts: [
      {
        scheme: 'exact',
        network: CAIP2,
        amount: X402_AMOUNT_BASE,
        asset: mint,
        payTo,
        maxTimeoutSeconds: X402_MAX_TIMEOUT_SECONDS,
        extra: { feePayer, decimals: USDC_DECIMALS },
      },
    ],
  };
  return error ? { ...body, error } : body;
}

/** PAYMENT-SIGNATURE 헤더(base64 JSON) 디코드. 외부 입력이므로 호출부가 예외를 잡는다. */
export function decodePaymentPayload(headerValue) {
  const json = Buffer.from(headerValue, 'base64').toString('utf8');
  const payload = JSON.parse(json);
  if (payload?.x402Version !== 2) throw new Error(`x402Version이 2가 아님: ${payload?.x402Version}`);
  const b64Tx = payload?.payload?.transaction;
  if (typeof b64Tx !== 'string' || !b64Tx) throw new Error('payload.transaction 없음');
  return payload;
}

/** facilitator 키 로드(없으면 명확히 실패 — 시드가 만든다). */
export function loadFacilitator() {
  const raw = fs.readFileSync(PATHS.facilitator, 'utf8');
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

/**
 * 부분 서명 tx가 우리가 제시한 조건과 일치하는지 검증한다.
 * 실패는 전부 throw — 호출부는 402를 다시 내려 데몬이 "결제 거부"로 기록하게 한다.
 * @returns {{amountBase:string, from:string}}
 */
function verifyTransfer(tx, facilitatorAddress, expected) {
  const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());

  // feePayer 슬롯(0번)이 우리 facilitator여야 공동 서명이 성립한다.
  if (keys[0] !== facilitatorAddress) {
    throw new Error(`feePayer가 facilitator가 아님: ${keys[0]}`);
  }

  const ixs = tx.message.compiledInstructions;
  if (ixs.length !== 1) throw new Error(`명령이 1건이 아님: ${ixs.length}건`);
  const ix = ixs[0];

  if (keys[ix.programIdIndex] !== TOKEN_PROGRAM_ID.toBase58()) {
    throw new Error(`SPL Token 프로그램이 아님: ${keys[ix.programIdIndex]}`);
  }

  const data = Buffer.from(ix.data);
  if (data.length !== TRANSFER_CHECKED_DATA_LEN || data[0] !== IX_TRANSFER_CHECKED) {
    throw new Error(`TransferChecked가 아님 (tag=${data[0]} len=${data.length})`);
  }

  const amount = data.readBigUInt64LE(1);
  const decimals = data[9];
  if (amount !== expected.amount) throw new Error(`금액 불일치: ${amount} != ${expected.amount}`);
  if (decimals !== expected.decimals) throw new Error(`decimals 불일치: ${decimals}`);

  // TransferChecked 계정 순서: source, mint, destination, authority
  const [sourceIdx, mintIdx, destIdx, authorityIdx] = ix.accountKeyIndexes;
  if (keys[mintIdx] !== expected.mint) throw new Error(`mint 불일치: ${keys[mintIdx]}`);
  if (keys[destIdx] !== expected.destAta) throw new Error(`수취 계정 불일치: ${keys[destIdx]}`);

  return { amountBase: amount.toString(), from: keys[authorityIdx], sourceAta: keys[sourceIdx] };
}

/**
 * signature가 확정될 때까지 폴링. 상한을 둔다 — 데몬의 재요청 타임아웃이 30초이고
 * 그 안에 검증·공동서명·제출·확정을 모두 끝내야 한다(초과하면 데몬은 실패로 기록하는데
 * 체인에는 결제가 남는 불일치가 생긴다). localnet 확정은 1초 미만이라 여유가 크다.
 */
async function waitConfirmed(conn, signature, timeoutMs = 8000, intervalMs = 300) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const st = await conn.getSignatureStatuses([signature]);
    const v = st.value[0];
    if (v?.err) throw new Error(`온체인 실패: ${JSON.stringify(v.err)}`);
    const status = v?.confirmationStatus;
    if (status === 'confirmed' || status === 'finalized') return status;
    await sleep(intervalMs);
  }
  throw new Error(`결제 확정 타임아웃 (${signature})`);
}

/**
 * 검증 → feePayer 공동 서명 → 제출 → 확정. 여기까지 성공해야 결과물을 내준다.
 * @returns {Promise<{signature:string, status:string, amountBase:string, from:string, paidAt:string}>}
 */
export async function settlePayment(conn, facilitator, payload, expected) {
  const tx = VersionedTransaction.deserialize(
    Buffer.from(payload.payload.transaction, 'base64'),
  );
  const verified = verifyTransfer(tx, facilitator.publicKey.toBase58(), expected);

  // 데몬은 자기 슬롯만 채운 부분 서명을 보낸다. 우리 서명은 feePayer 슬롯에만 들어간다.
  tx.sign([facilitator]);
  const signature = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
  const status = await waitConfirmed(conn, signature);

  return {
    signature,
    status,
    amountBase: verified.amountBase,
    from: verified.from,
    paidAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// 결제 완료 마커 (중복 결제 방어)
// ---------------------------------------------------------------------------
//
// 같은 엔드포인트를 웹 UI 프록시·verify-e2e·flow가 여러 번 호출한다. 데몬은 402를 받으면
// 무조건 다시 결제하므로 마커가 없으면 호출마다 재결제된다. result-cache에 영속하면
// 시드가 캐시를 통째로 지우는 것과 자연히 정합된다(새 데모 사이클 = 마커도 무효).

function markerPath(auctionId) {
  return path.join(PATHS.resultCache, `payment-${auctionId}.json`);
}

/** 결제 완료 마커. 없거나 손상되면 null(미결제로 간주). */
export function readPaymentMarker(auctionId) {
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath(auctionId), 'utf8'));
    return marker?.signature ? marker : null;
  } catch {
    return null;
  }
}

/** 마커 기록. temp+rename으로 원자적 교체(부분·동시 쓰기 손상 방지). */
export function writePaymentMarker(auctionId, marker) {
  const target = markerPath(auctionId);
  fs.mkdirSync(PATHS.resultCache, { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(marker));
  fs.renameSync(tmp, target);
}
