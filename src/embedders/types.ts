/** 재임베딩에 쓰는 임베더. 텍스트 배치를 받아 같은 순서의 벡터 배치를 돌려준다. */
export interface Embedder {
  /** 이어서 하기 계획 해시에 들어가는 식별자(모델이 바뀌면 이어서 하기를 거부하기 위해) */
  id?: string;
  /** 알고 있으면 출력 차원 */
  dims?: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}
