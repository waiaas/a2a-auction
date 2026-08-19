/**
 * 지갑 연결 계층.
 *
 * **Wallet Standard 하나로 D'CENT와 Phantom을 함께 덮는다.** 두 지갑 모두 브라우저에
 * 자기 자신을 등록하므로 지갑별 어댑터나 WalletConnect가 필요 없다. 여기서 하는 일은
 * 등록된 지갑을 모아 하나의 인터페이스(`address`·`signMessage`·`signTransaction`)로
 * 감싸는 것뿐이다.
 *
 * 임시 체험 지갑도 같은 인터페이스로 낸다. 심사위원이 익스텐션 설치 없이 흐름 전체를 볼 수
 * 있어야 하고, 그때도 **서명은 브라우저에서 일어나야** 이 데모가 말하는 위임 구조가 유지된다
 * (서버가 대신 서명하면 "사람이 맡긴다"가 사라진다). 키는 브라우저 안에만 있다.
 */
import { encodeBase58, decodeBase58 } from './base58.js';

const toBase64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const fromBase64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** 지갑이 트랜잭션 서명 시 요구하는 체인 식별자. 데몬이 쓰는 네트워크와 맞춘다. */
const CHAIN = 'solana:devnet';

// ---- Wallet Standard 발견 ----

/**
 * 등록된 지갑을 모은다.
 *
 * 프로토콜이 양방향이라 둘 다 필요하다. 이미 로드된 지갑은 우리가 보내는 `app-ready`를 듣고,
 * 나중에 로드되는 지갑은 자기가 `register-wallet`을 보낸다. 한쪽만 처리하면 지갑이 먼저
 * 뜨느냐 페이지가 먼저 뜨느냐에 따라 연결이 되기도 하고 안 되기도 한다.
 */
export function discoverWallets() {
  const found = new Map();
  const api = {
    register(...wallets) {
      for (const w of wallets) found.set(w.name, w);
      return () => {};
    },
  };
  const onRegister = (e) => e.detail(api);
  window.addEventListener('wallet-standard:register-wallet', onRegister);
  window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: api }));
  window.removeEventListener('wallet-standard:register-wallet', onRegister);

  return [...found.values()].filter((w) => w.features?.['solana:signMessage'] && w.features?.['standard:connect']);
}

/** Wallet Standard 지갑 하나를 연결해 통일 인터페이스로 감싼다. */
export async function connectStandard(wallet) {
  const { accounts } = await wallet.features['standard:connect'].connect();
  const account = accounts?.[0];
  if (!account) throw new Error('지갑이 계정을 돌려주지 않았습니다.');

  const signTx = wallet.features['solana:signTransaction'];
  return {
    kind: 'standard',
    name: wallet.name,
    icon: wallet.icon,
    address: account.address,

    async signMessage(message) {
      const [out] = await wallet.features['solana:signMessage'].signMessage({
        account,
        message: new TextEncoder().encode(message),
      });
      return toBase64(out.signature);
    },

    async signTransaction(txBase64) {
      if (!signTx) {
        throw new Error(`${wallet.name}은 트랜잭션 서명을 지원하지 않습니다.`);
      }
      // **서명만 받고 전송은 서버가 한다.** 지갑의 signAndSend는 지갑 자신의 RPC로 보내는데,
      // 이 데모의 체인은 우리 밸리데이터라 지갑이 닿지 못한다.
      const [out] = await signTx.signTransaction({
        account,
        transaction: fromBase64(txBase64),
        chain: CHAIN,
      });
      return toBase64(out.signedTransaction);
    },
  };
}

// ---- 임시 체험 지갑 (브라우저 내 키) ----

const LOCAL_KEY = 'a2a.localWallet';

/** Web Crypto의 Ed25519 지원 여부. 없으면 체험 지갑 옵션 자체를 숨긴다. */
export async function supportsLocalWallet() {
  try {
    await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    return true;
  } catch {
    return false;
  }
}

async function importLocal(stored) {
  const priv = await crypto.subtle.importKey('pkcs8', fromBase64(stored.pkcs8), { name: 'Ed25519' }, true, ['sign']);
  return { priv, address: stored.address };
}

async function createLocal() {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const rawPub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const pkcs8 = toBase64(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const address = encodeBase58(rawPub);
  localStorage.setItem(LOCAL_KEY, JSON.stringify({ pkcs8, address }));
  return { priv: pair.privateKey, address };
}

/**
 * 임시 체험 지갑을 연다(있으면 재사용).
 *
 * 재사용이 중요하다. 새로고침마다 새 지갑이 생기면 어제 산 것도, 방금 맡긴 자금도 사라져
 * "내 에이전트"라는 감각이 성립하지 않는다.
 */
export async function connectLocal() {
  const stored = localStorage.getItem(LOCAL_KEY);
  const { priv, address } = stored ? await importLocal(JSON.parse(stored)) : await createLocal();

  return {
    kind: 'local',
    name: '임시 체험 지갑',
    icon: null,
    address,

    async signMessage(message) {
      const sig = await crypto.subtle.sign({ name: 'Ed25519' }, priv, new TextEncoder().encode(message));
      return toBase64(sig);
    },

    /**
     * legacy 트랜잭션에 서명 하나를 채운다.
     *
     * 직렬화 형식은 `[서명 개수][서명 64바이트 × n][메시지]`다. 서버가 오너 단독 서명으로
     * 조립하므로 개수는 항상 1이고, 그래서 첫 바이트 뒤 64바이트가 우리 자리, 그 뒤가 서명
     * 대상 메시지가 된다. 라이브러리 없이 처리할 수 있는 이유가 이 단순함이다.
     */
    async signTransaction(txBase64) {
      const raw = fromBase64(txBase64);
      if (raw[0] !== 1) throw new Error('서명자가 한 명인 트랜잭션만 지원합니다.');
      const message = raw.slice(1 + 64);
      const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, priv, message));
      raw.set(sig, 1);
      return toBase64(raw);
    },
  };
}

/** 체험 지갑을 버린다(다른 사람에게 넘길 때). */
export function forgetLocalWallet() {
  localStorage.removeItem(LOCAL_KEY);
}

export { decodeBase58 };
