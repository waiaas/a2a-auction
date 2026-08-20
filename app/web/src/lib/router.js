import { useEffect, useState } from 'react';

/**
 * 해시 서브라우터 (8/20 피드백 "한 화면 갈아끼우기는 서비스 같지 않다").
 *
 * react-router를 넣지 않는다. App.jsx의 `viewFromHash()`가 `#live`/`#purchase` 외 모든
 * 해시를 `service`로 보내므로, `#/...` 경로는 App을 건드리지 않고 ServiceView 안에서
 * 페이지가 된다. **같은 view 값이라 ServiceView가 재마운트되지 않는 것이 핵심이다** —
 * 지갑 ref·폴링·draft가 페이지 전환에서 그대로 살아남아, "라우팅을 피했던 이유"(새로고침·
 * 뒤로가기로 진행 중 구매가 끊기는 위험)를 그대로 지키면서 URL 이동을 얻는다.
 */
export function parseRoute(hash) {
  if (!hash?.startsWith('#/')) return { page: 'home', param: null };
  const [seg, param] = hash.slice(2).split('/');
  switch (seg) {
    case 'request': return { page: 'request', param: null };
    case 'tasks': return param ? { page: 'task', param } : { page: 'tasks', param: null };
    case 'result': return param ? { page: 'result', param } : { page: 'home', param: null };
    case 'receipt': return { page: 'receipt', param: null };
    case 'mcp': return { page: 'mcp', param: null };
    default: return { page: 'home', param: null };
  }
}

/** 해시를 바꿔 이동한다. 히스토리에 쌓이므로 뒤로가기가 공짜로 된다. */
export function navigate(path) {
  window.location.hash = path;
}

export function useHashRoute() {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));

  useEffect(() => {
    const onHash = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // 페이지가 바뀌면 맨 위에서 시작한다. 스크롤이 이전 페이지 위치에 남으면 "화면만
  // 갈아껴졌다"는 인상이 그대로 남는다.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [route.page, route.param]);

  return route;
}
