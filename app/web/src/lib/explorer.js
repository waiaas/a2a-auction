/**
 * 온체인 서명을 explorer 링크로 바꾼다.
 *
 * 영수증에 찍히는 서명은 이 데모에서 **가장 강한 증거**다(실제로 체인에 남았고 누구나
 * 검증할 수 있다). 그런데 지금까지 화면은 잘린 문자열만 보여주고 클릭하면 복사만 됐다.
 * 심사위원이 "진짜로 온체인이냐"를 그 자리에서 확인할 방법이 없으면 증거는 없는 것과 같다.
 *
 * **cluster를 화면이 판정하지 않는다.** 서버가 RPC 주소에서 판정해 내려준 값(`network`)을
 * 그대로 쓴다. 프론트에 문자열을 박으면 어느 체인에 배포하든 같은 링크가 나가 화면이
 * 거짓을 말한다(`config.js`의 networkLabelFrom과 같은 이유).
 */
import { createContext, useContext } from 'react';

/** 서버가 network를 아직 안 내려준 초기 렌더용 기본값. 배포본이 devnet이라 여기에 맞춘다. */
export const ClusterContext = createContext('devnet');

export const useCluster = () => useContext(ClusterContext);

/**
 * @returns {string|null} explorer URL. **로컬 체인이면 null**이다 —
 *   public explorer가 로컬 밸리데이터에 닿지 못하므로 링크를 걸면 리허설에서
 *   "없는 트랜잭션"이 뜬다. 그 경우 호출부가 기존 복사 동작으로 되돌린다.
 */
export function txUrl(sig, cluster) {
  if (!sig) return null;
  const base = `https://explorer.solana.com/tx/${sig}`;
  if (cluster === 'mainnet') return base; // mainnet-beta는 파라미터가 없는 것이 기본값이다
  if (cluster === 'devnet' || cluster === 'testnet') return `${base}?cluster=${cluster}`;
  return null; // localnet · custom
}
