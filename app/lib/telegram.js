/**
 * 텔레그램 승인 알림 (8/19 퀵싱크 신설).
 *
 * **"메시지가 날아오는 게 데모에서 중요하다"**(회의 36:16). 에이전트가 한도를 넘는 지출을
 * 하려 할 때 사람이 그 사실을 어디서 알게 되는지가 WAIaaS의 주장 그 자체다.
 *
 * **알림과 링크만 보내고 승인은 웹에서 지갑 서명으로 한다.** 인라인 버튼으로 즉시 승인하면
 * 서명 없이 텔레그램 계정만으로 돈이 나가는 구조가 되어, WAIaaS가 막겠다는 것을 스스로 하게
 * 된다. 링크를 한 번 더 타는 번거로움이 곧 이 서비스가 파는 것이다.
 *
 * 토큰이 없으면 조용히 건너뛴다 — 알림은 부가 채널이고, 이것 때문에 구매가 실패하면 안 된다.
 */
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');

export const isTelegramEnabled = Boolean(BOT_TOKEN && CHAT_ID);

/** 텔레그램 MarkdownV2가 예약한 문자들. 이스케이프하지 않으면 400으로 떨어진다. */
function escapeMd(text) {
  return String(text).replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

async function send(text, replyMarkup) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: true,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`텔레그램 ${res.status}: ${body.slice(0, 200)}`);
  }
}

/**
 * 승인 요청 알림.
 *
 * @param {object} purchase - 구매 건
 * @param {{notifyMaxUsdc:number, delayMaxUsdc:number}} limits - 화면과 같은 한도
 * @returns {Promise<boolean>} 보냈으면 true, 설정이 없어 건너뛰었으면 false
 */
export async function notifyApprovalNeeded(purchase, limits = {}) {
  if (!isTelegramEnabled) return false;

  const lines = [
    '🔔 *에이전트가 승인을 요청했습니다*',
    '',
    `${escapeMd(purchase.listing.sellerEmoji ?? '')} ${escapeMd(purchase.listing.sellerName)}`,
    `*${escapeMd(String(purchase.amountUsdc))} USDC*`,
    '',
    escapeMd(
      limits.delayMaxUsdc != null
        ? `맡긴 한도 ${limits.delayMaxUsdc} USDC를 넘어 내 지갑 서명이 필요합니다.`
        : '맡긴 한도를 넘어 내 지갑 서명이 필요합니다.',
    ),
    escapeMd(`의뢰: ${purchase.title}`),
  ];

  // 딥링크는 웹으로 되돌린다. 승인은 지갑 서명이라 도구나 봇이 대신할 수 없다.
  const markup = PUBLIC_URL
    ? { inline_keyboard: [[{ text: '승인하러 가기', url: PUBLIC_URL }]] }
    : undefined;

  await send(lines.join('\n'), markup);
  return true;
}

/**
 * 유예 알림. 화면은 "60초 유예 후 진행되고 그 사이 취소할 수 있습니다"라고 안내하는데,
 * 그 60초를 폰으로 알 수 없으면 취소할 기회가 자리를 지키고 있는 사람에게만 열린다.
 */
export async function notifyDelayed(purchase, limits = {}) {
  if (!isTelegramEnabled) return false;

  const seconds = limits.delaySeconds ?? 60;
  const lines = [
    '⏳ *에이전트가 잠시 기다립니다*',
    '',
    `${escapeMd(purchase.listing.sellerEmoji ?? '')} ${escapeMd(purchase.listing.sellerName)}`,
    `*${escapeMd(String(purchase.amountUsdc))} USDC*`,
    '',
    escapeMd(`${seconds}초 뒤 스스로 진행합니다. 그 사이에 취소할 수 있습니다.`),
    escapeMd(`의뢰: ${purchase.title}`),
  ];
  const markup = PUBLIC_URL
    ? { inline_keyboard: [[{ text: '지금 취소하러 가기', url: PUBLIC_URL }]] }
    : undefined;

  await send(lines.join('\n'), markup);
  return true;
}

/**
 * 한도 안이라 그대로 진행된 건(NOTIFY·INSTANT).
 *
 * **이 알림이 없으면 화면이 거짓말을 한다.** 티어 이름이 NOTIFY이고, 스펙 타일도 정책
 * 카드도 "알림만 가고 그대로 진행됩니다"라고 적는데 정작 폰은 조용했다(8/21 리허설에서
 * 발견). 개입할 것이 없다고 알릴 것도 없는 건 아니다 — 맡긴 사람이 알아야 할 지출이다.
 *
 * 버튼은 붙이지 않는다. 이미 끝난 일이라 눌러서 할 것이 없다.
 */
export async function notifyExecuted(purchase, limits = {}) {
  if (!isTelegramEnabled) return false;

  const cap = limits.notifyMaxUsdc;
  const lines = [
    '🤖 *에이전트가 스스로 샀습니다*',
    '',
    `${escapeMd(purchase.listing.sellerEmoji ?? '')} ${escapeMd(purchase.listing.sellerName)}`,
    `*${escapeMd(String(purchase.amountUsdc))} USDC*`,
    '',
    escapeMd(cap != null ? `${cap} USDC까지는 알림만 가고 그대로 진행됩니다.` : '한도 안이라 그대로 진행했습니다.'),
    escapeMd(`의뢰: ${purchase.title}`),
  ];

  await send(lines.join('\n'));
  return true;
}

/** 승인·거부의 결말. 알림만 오고 결과를 모르면 사람이 웹을 계속 들여다봐야 한다. */
export async function notifyResolved(purchase, action) {
  if (!isTelegramEnabled) return false;
  const head = action === 'approve' ? '✅ *승인됨*' : '↩️ *거부됨*';
  const tail =
    action === 'approve'
      ? escapeMd('에이전트가 이어서 진행합니다.')
      : escapeMd('돈은 나가지 않았습니다.');
  await send([head, '', `${escapeMd(purchase.listing.sellerName)} · ${escapeMd(String(purchase.amountUsdc))} USDC`, '', tail].join('\n'));
  return true;
}
