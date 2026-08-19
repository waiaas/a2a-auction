/**
 * 텔레그램 봇 설정 도우미.
 *
 * BotFather에서 받은 토큰만 `infra/.env`에 넣으면 나머지(챗 ID 조회·연결 확인·테스트 발송)를
 * 여기서 처리한다. **토큰은 그 채팅방에 쓸 수 있는 권한 그 자체라** 화면이나 로그에 전문을
 * 찍지 않는다.
 *
 * 실행:
 *   node setup-telegram.mjs            챗 ID를 찾아 알려준다
 *   node setup-telegram.mjs --test     실제 승인 요청 메시지를 한 번 보낸다
 */
const TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const CHAT_ID = (process.env.TELEGRAM_CHAT_ID || '').trim();
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const isTest = process.argv.includes('--test');

function mask(t) {
  return t.length > 12 ? `${t.slice(0, 6)}…${t.slice(-4)}` : '(짧음)';
}

if (!TOKEN) {
  console.log('TELEGRAM_BOT_TOKEN이 없습니다.\n');
  console.log('  1. 텔레그램에서 @BotFather 를 찾아 /newbot 을 보냅니다');
  console.log('  2. 봇 이름과 username을 정하면 토큰을 줍니다');
  console.log('  3. 그 토큰을 infra/.env 에 아래 형식으로 추가합니다\n');
  console.log('     TELEGRAM_BOT_TOKEN=여기에토큰');
  process.exit(1);
}

console.log(`토큰 ${mask(TOKEN)}\n`);

// 1. 토큰이 살아 있는지
const me = await (await fetch(`https://api.telegram.org/bot${TOKEN}/getMe`)).json();
if (!me.ok) {
  console.error(`✗ 토큰이 유효하지 않습니다: ${me.description ?? JSON.stringify(me)}`);
  process.exit(1);
}
console.log(`✓ 봇 확인 — @${me.result.username} (${me.result.first_name})`);

// 2. 챗 ID. 봇은 먼저 말을 걸 수 없어서 사람이 한 번 보낸 기록이 있어야 한다.
if (!CHAT_ID) {
  const updates = await (await fetch(`https://api.telegram.org/bot${TOKEN}/getUpdates`)).json();
  const chats = new Map();
  for (const u of updates.result ?? []) {
    const chat = u.message?.chat ?? u.channel_post?.chat;
    if (chat) chats.set(chat.id, chat);
  }

  if (!chats.size) {
    console.log('\n✗ 챗 ID를 찾지 못했습니다.');
    console.log(`  텔레그램에서 @${me.result.username} 을 열고 아무 메시지나 한 번 보낸 뒤 다시 실행해 주세요.`);
    console.log('  (봇은 먼저 말을 걸 수 없어, 사람이 보낸 기록이 있어야 챗 ID가 생깁니다)');
    process.exit(1);
  }

  console.log('\n찾은 대화:');
  for (const [id, chat] of chats) {
    const who = chat.title ?? `${chat.first_name ?? ''} ${chat.last_name ?? ''}`.trim() ?? chat.username;
    console.log(`  ${id}  ${chat.type}  ${who}`);
  }
  const [firstId] = [...chats.keys()];
  console.log('\ninfra/.env 에 아래 줄을 추가하세요:\n');
  console.log(`     TELEGRAM_CHAT_ID=${firstId}`);
  if (!PUBLIC_URL) {
    console.log('\n  딥링크(승인하러 가기 버튼)를 쓰려면 PUBLIC_URL도 함께 넣으세요:\n');
    console.log('     PUBLIC_URL=https://a2a-house.8-230-9-237.nip.io');
  }
  process.exit(0);
}

console.log(`✓ 챗 ID ${CHAT_ID}`);
console.log(PUBLIC_URL ? `✓ 딥링크 ${PUBLIC_URL}` : '! PUBLIC_URL이 없어 "승인하러 가기" 버튼이 빠집니다');

if (!isTest) {
  console.log('\n설정이 끝났습니다. 실제 메시지를 보내 보려면 --test 를 붙여 실행하세요.');
  process.exit(0);
}

// 3. 실제 발송. 데모에서 나갈 메시지와 같은 함수를 쓴다 — 여기서 되면 데모에서도 된다.
const { notifyApprovalNeeded } = await import('./lib/telegram.js');
const sent = await notifyApprovalNeeded(
  {
    title: 'Solana 연말 가격 예측 리서치',
    amountUsdc: 20,
    listing: { sellerName: 'Deep Research Agent', sellerEmoji: '🔬' },
  },
  { notifyMaxUsdc: 5, delayMaxUsdc: 10 },
);
console.log(sent ? '\n✓ 테스트 메시지를 보냈습니다. 텔레그램을 확인해 주세요.' : '\n✗ 설정이 비어 있어 보내지 않았습니다.');
