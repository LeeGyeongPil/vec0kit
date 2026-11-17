// vec0kit 이 던지는 오류는 모두 Vec0KitError 하나로 모은다.
// code 는 언어와 무관한 식별자라 CLI 가 종료 코드와 번역 메시지를 고르는 데 쓴다.

export type Vec0KitErrorCode =
  | "E_USAGE"
  | "E_NO_DB"
  | "E_NOT_DB"
  | "E_PARSE"
  | "E_NO_TABLE"
  | "E_PLAN"
  | "E_LIMIT"
  | "E_INVALID_VECTORS"
  | "E_VERIFY"
  | "E_RESUME_MISMATCH"
  | "E_LOCKED"
  | "E_EMBED"
  | "E_EXTENSION";

/** 메시지 번역에 끼워 넣을 값(문자열·숫자만). */
export type MessageParams = Record<string, string | number>;

export class Vec0KitError extends Error {
  readonly code: Vec0KitErrorCode;
  /** 사람용 메시지 번역에 쓰는 값 */
  readonly params: MessageParams;
  /** 기계용 추가 정보(예: 검증 보고, 잘못된 벡터 rowid 목록) */
  readonly details: unknown;

  constructor(code: Vec0KitErrorCode, message: string, params: MessageParams = {}, details?: unknown) {
    super(message);
    this.name = "Vec0KitError";
    this.code = code;
    this.params = params;
    this.details = details;
  }
}

/** CLI 종료 코드: 1 = 데이터 문제(검증 실패·잘못된 벡터), 2 = 사용법·계획 거부, 3 = 실행 오류. */
export function exitCodeFor(code: Vec0KitErrorCode): number {
  switch (code) {
    case "E_INVALID_VECTORS":
    case "E_VERIFY":
      return 1;
    case "E_USAGE":
    case "E_NO_DB":
    case "E_NOT_DB":
    case "E_NO_TABLE":
    case "E_PLAN":
    case "E_LIMIT":
    case "E_RESUME_MISMATCH":
      return 2;
    default:
      return 3;
  }
}
