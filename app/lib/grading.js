/**
 * 결과물 채점 (8/19 퀵싱크 반영분).
 *
 * **여기가 라이브 채점이 도는 유일한 자리다.** 구매 전 샘플 채점은 샘플도 프롬프트도 고정이라
 * 매번 같은 값이 나와 저장해 두고 쓰지만, 결과물은 매번 새로 만들어지므로 값이 고정될 수 없다.
 *
 * 채점 결과는 그 리스팅의 평점이 된다(`scoring.recordScore`). "평점은 어뷰징할 수 있지
 * 않느냐"에 답하려면 그 숫자가 어디서 왔는지 말할 수 있어야 하고, 그 답이 이 함수다.
 *
 * 라이브가 못 돌면(키 없음·쿼터 소진) 본문에서 채점 신호를 세어 매긴다. 목업이 아니라
 * **자를 바꾼 것**이다 — 어느 경로든 실제로 본문을 읽고 점수를 낸다.
 */
import { generateFunctionCall } from './gemini.js';
import { loadCriteria } from './scoring.js';

/** 채점 결과를 받는 함수 정의. 항목별로 받아야 화면이 근거를 펼칠 수 있다. */
function gradeFn(criteria) {
  return {
    name: 'grade_result',
    description: '결과물을 기준 항목별로 채점한다. 각 항목은 0점부터 만점까지다.',
    parameters: {
      type: 'object',
      properties: {
        scores: {
          type: 'object',
          description: '항목 id를 키로 하는 점수',
          properties: Object.fromEntries(
            criteria.items.map((c) => [
              c.id,
              { type: 'integer', description: `${c.label} (0~${c.max}). ${c.hint}` },
            ]),
          ),
          required: criteria.items.map((c) => c.id),
        },
        notes: {
          type: 'object',
          description: '항목별 한 문장 근거. 점수를 깎았으면 무엇이 부족했는지 밝힐 것',
          properties: Object.fromEntries(
            criteria.items.map((c) => [c.id, { type: 'string', description: `${c.label} 근거` }]),
          ),
        },
      },
      required: ['scores'],
    },
  };
}

/**
 * 반복과 공백을 걷어낸 실질 분량.
 *
 * **글자 수는 시도만으로 부풀릴 수 있다.** 같은 문장을 스무 번 붙이거나 공백을 채우면 분량은
 * 늘지만 다뤄낸 것은 하나도 늘지 않는다(실측: 신호어만 박은 106자를 공백으로 500자까지 늘리자
 * 42점이 80점이 됐다). 그래서 문장 단위로 잘라 중복을 지운 뒤 센다.
 */
function substanceOf(text) {
  const sentences = text
    .split(/[.!?\n]/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 1);
  return [...new Set(sentences)].join('').length;
}

/**
 * 라이브가 못 돌 때의 채점. 본문에서 각 항목의 신호를 세어 매긴다.
 *
 * 신호는 그 항목이 실제로 요구하는 것에 맞춘다 — 예를 들어 '리스크 명시'는 분량이 아니라
 * "틀릴 조건을 적었는가"라서, 길이가 아니라 해당 표현의 등장으로 잰다.
 */
function gradeBySignals(markdown, criteria) {
  const text = markdown || '';
  const substance = substanceOf(text);
  const numbers = (text.match(/\d[\d,.]*\s*(%|배|건|억|만|달러|USDC)/g) ?? []).length;
  const tableRows = (text.match(/^\s*\|.*\|\s*$/gm) ?? []).length;
  const headings = (text.match(/^#{1,3}\s/gm) ?? []).length;

  const has = (re) => re.test(text);
  const signal = {
    // 수치 근거가 주가 되고 표는 거들 뿐이다. 표에 비중을 크게 주면 서술형 심층 리포트가
    // 수치를 많이 들고도 낮게 나온다(실측에서 실제로 그랬다).
    evidence: Math.min(1, (numbers / 9) * 0.8 + (tableRows / 8) * 0.2),
    // 갈리는 경로를 나눴는가. 표현이 없으면 결론 하나만 민 것이다.
    scenario: has(/시나리오|경로 [ABC]|가능성 (높|낮)|전망을 나눠|세 가지/) ? 1 : has(/전망|추세/) ? 0.45 : 0.2,
    // 틀릴 조건을 스스로 밝혔는가.
    risk: has(/틀릴 조건|리스크|위험|취약|오차|주의해야|한계/) ? (has(/틀릴 조건|한계/) ? 1 : 0.7) : 0.25,
    // 출처를 따라갈 수 있는가.
    source: has(/출처|참고|부록|링크|1차 소스|블록 범위/) ? (has(/부록|1차 소스|블록 범위/) ? 1 : 0.65) : 0.3,
    // 읽고 나서 무엇을 할지 정할 수 있는가. 구조가 잡혀 있고 분량이 받쳐야 한다.
    actionable: Math.min(1, (headings / 6) * 0.5 + Math.min(1, substance / 2500) * 0.5),
  };

  // **무엇을 보고 이 점수가 됐는지 그대로 적는다.** 근거 없는 점수는 화면에서 "정규식이
  // 매긴 숫자"로만 남고, 그러면 "평점 어뷰징을 무엇으로 막나"에 답할 자리가 사라진다.
  // 규칙으로 잰 것이 부끄러운 게 아니라 무엇을 쟀는지 숨기는 것이 문제다.
  const note = {
    evidence: `수치 표현 ${numbers}개, 표 ${tableRows}행을 셌다.`,
    scenario: has(/시나리오|경로 [ABC]|가능성 (높|낮)|전망을 나눠|세 가지/)
      ? '갈리는 경로를 나눈 표현이 있다.'
      : has(/전망|추세/)
        ? '방향은 언급했으나 경로를 나누지는 않았다.'
        : '결론 하나만 제시하고 경로를 나누지 않았다.',
    risk: has(/틀릴 조건|한계/)
      ? '이 판단이 틀릴 조건을 밝혔다.'
      : has(/리스크|위험|취약|오차|주의해야/)
        ? '위험은 언급했으나 틀릴 조건까지는 밝히지 않았다.'
        : '틀릴 조건이나 위험을 밝힌 표현이 없다.',
    source: has(/부록|1차 소스|블록 범위/)
      ? '따라갈 수 있는 출처(부록·1차 소스)를 남겼다.'
      : has(/출처|참고|링크/)
        ? '출처를 언급했으나 개별 항목까지는 밝히지 않았다.'
        : '출처를 밝힌 표현이 없다.',
    actionable: `제목 ${headings}개, 반복을 뺀 실질 분량 ${substance}자로 구조와 깊이를 봤다.`,
  };

  // **얕은 글은 항목마다 천장을 낮춘다.** 이 채점기의 진짜 구멍은 분량이 아니라 신호어였다 —
  // '시나리오·틀릴 조건·부록' 세 단어만 박으면 106자짜리도 세 항목에서 만점을 가져간다(실측
  // 78점으로, 1839자 심층 리포트의 75점보다 높았다). 신호는 "그 항목을 다루려는 시도"만 잴 뿐
  // 다뤄냈는지는 재지 못하므로, 실질 분량에 비례하는 천장을 항목마다 씌워 "짧은 글이 다섯
  // 기준을 모두 충족했다"는 주장을 막는다.
  //
  // 곱셈이 아니라 천장인 이유: 분량이 받쳐주는 글은 깎을 이유가 없다. 총점에 계수를 곱하면
  // 실제 샘플까지 함께 내려가고(실측: brief 57 → 30) 정작 분량만 늘린 글은 안 걸린다.
  const DEPTH_FULL_CHARS = 900;
  const depth = Math.min(1, substance / DEPTH_FULL_CHARS);

  return criteria.items.map((c) => {
    const raw = Math.max(1, Math.round((signal[c.id] ?? 0.5) * c.max));
    const ceiling = Math.max(1, Math.round(depth * c.max));
    const capped = Math.min(raw, ceiling);
    // 실질 분량 숫자는 actionable 근거가 이미 들고 있다. 다섯 줄이 한 표에 나란히 서므로
    // 항목마다 같은 숫자를 반복하면 표가 지저분해진다.
    const capNote = capped < raw ? ` 실질 분량이 짧아 ${ceiling}점이 상한이다.` : '';
    return { id: c.id, score: capped, note: (note[c.id] ?? '') + capNote || null };
  });
}

/**
 * 결과물 한 건을 채점한다.
 *
 * @param {string} markdown - 결과물 본문
 * @param {{kind?:string, task?:string, sellerName?:string}} meta
 * @returns {Promise<{score:number, breakdown:object[], criteria:object, source:'live'|'signals'}>}
 */
export async function gradeResult(markdown, meta = {}) {
  const criteria = loadCriteria(meta.kind ?? 'research');
  const body = String(markdown ?? '');

  const prompt =
    '아래 결과물을 채점하라. 후하게 주지 말고 기준에 없는 것은 점수로 인정하지 마라.\n\n' +
    `[의뢰 내용]\n${meta.task ?? '(없음)'}\n\n` +
    `[채점 기준]\n${criteria.items.map((c) => `- ${c.label} (0~${c.max}): ${c.hint}`).join('\n')}\n\n` +
    `[결과물]\n${body.slice(0, 12000)}`;

  const args = await generateFunctionCall(prompt, gradeFn(criteria), { timeoutMs: 25000 });

  let breakdown;
  let source;
  if (args?.scores) {
    breakdown = criteria.items.map((c) => ({
      id: c.id,
      // 모델이 만점을 넘기거나 음수를 주는 경우가 있어 경계에서 자른다.
      score: Math.max(0, Math.min(c.max, Math.round(Number(args.scores[c.id]) || 0))),
      note: args.notes?.[c.id] ?? null,
    }));
    source = 'live';
  } else {
    breakdown = gradeBySignals(body, criteria);
    source = 'signals';
  }

  const score = breakdown.reduce((sum, b) => sum + b.score, 0);
  return { score, breakdown, criteria, source };
}
