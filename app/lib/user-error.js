/**
 * 사용자에게 그대로 보여도 되는 오류.
 *
 * 내부 오류(데몬 불달, RPC 실패)와 **입력이 잘못된 것**은 다른 사건이다. 둘을 같은 502로
 * 접으면 화면이 "일시적 오류"라고 말하는데 사실은 사용자가 값을 고치면 되는 상황이라,
 * 사용자는 고칠 수 있는 것을 못 고친 채 기다린다.
 */
export class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'UserError';
    this.status = status;
  }
}
