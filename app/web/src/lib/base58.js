/**
 * base58 (Bitcoin 알파벳). Solana 주소·서명 표기에 쓴다.
 *
 * 라이브러리를 넣지 않는 이유: 프론트가 지갑 연결 하나 때문에 `@solana/web3.js`를 끌어오면
 * Buffer 폴리필까지 딸려와 번들과 빌드 설정이 함께 커진다. 필요한 것은 주소 표기와 32바이트
 * 공개키 변환뿐이라 여기서 끝난다.
 */
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function encodeBase58(bytes) {
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  // 앞쪽 0바이트는 '1'로 그대로 옮긴다(주소 앞자리가 사라지면 다른 주소가 된다).
  let out = '';
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) out += '1';
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]];
  return out;
}

export function decodeBase58(str) {
  const bytes = [0];
  for (const ch of str) {
    const value = ALPHABET.indexOf(ch);
    if (value < 0) throw new Error(`base58이 아닌 문자: ${ch}`);
    let carry = value;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let i = 0; i < str.length && str[i] === '1'; i++) bytes.push(0);
  return Uint8Array.from(bytes.reverse());
}

/** 화면용 축약 표기. 앞뒤를 남겨야 사용자가 자기 주소인지 알아본다. */
export function shortAddress(address, head = 4, tail = 4) {
  if (!address || address.length <= head + tail + 1) return address || '';
  return `${address.slice(0, head)}…${address.slice(-tail)}`;
}
