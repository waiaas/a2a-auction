/**
 * 최소 마크다운 파서.
 *
 * 결과물과 샘플은 우리가 만든 마크다운이라 문법이 제한적이다(제목·문단·표·목록·굵게·구분선).
 * 그 범위만 처리하면 되므로 의존성을 늘리지 않는다 — 렌더링 하나 때문에 번들에 파서를
 * 통째로 넣으면 데모 로딩이 그만큼 늦어진다.
 *
 * 파싱과 렌더를 나눈 이유는 미리보기 때문이다. 샘플 모달은 앞부분만 보여주는데, 문자열을
 * 잘라 내면 표 중간에서 끊겨 깨진다. 블록 단위로 자르면 어디서 끊어도 형태가 남는다.
 */

/** `**굵게**`만 인라인으로 처리한다. 반환은 렌더가 그대로 map 할 수 있는 조각 배열이다. */
export function inlineParts(text) {
  return String(text)
    .split(/(\*\*[^*]+\*\*)/g)
    .filter(Boolean)
    .map((chunk) =>
      chunk.startsWith('**') && chunk.endsWith('**')
        ? { bold: true, text: chunk.slice(2, -2) }
        : { bold: false, text: chunk },
    );
}

function parseTableRow(line) {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim());
}

/** 구분선 행(`| --- | --- |`)인지. 표의 머리와 몸을 가르는 줄이라 내용이 아니다. */
function isDivider(line) {
  return /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes('-');
}

/**
 * 마크다운을 블록 배열로 만든다.
 *
 * @returns {Array<{type:'h'|'p'|'ul'|'table'|'hr', level?:number, text?:string, items?:string[], head?:string[], rows?:string[][]}>}
 */
export function parseBlocks(markdown) {
  const lines = String(markdown ?? '').split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i += 1; continue; }

    if (/^\s*(---|___|\*\*\*)\s*$/.test(line)) {
      blocks.push({ type: 'hr' });
      i += 1;
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      blocks.push({ type: 'h', level: heading[1].length, text: heading[2].trim() });
      i += 1;
      continue;
    }

    if (line.trim().startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        if (!isDivider(lines[i])) rows.push(parseTableRow(lines[i]));
        i += 1;
      }
      if (rows.length) blocks.push({ type: 'table', head: rows[0], rows: rows.slice(1) });
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, '').trim());
        i += 1;
      }
      blocks.push({ type: 'ul', items });
      continue;
    }

    // 빈 줄이 나올 때까지가 한 문단이다.
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^\s*[-*#|]/.test(lines[i])) {
      para.push(lines[i].trim());
      i += 1;
    }
    if (para.length) blocks.push({ type: 'p', text: para.join(' ') });
    else i += 1;
  }

  return blocks;
}
