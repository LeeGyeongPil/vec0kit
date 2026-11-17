// 연습용 목(mock) 임베더: 의미 모델이 아니라 토큰 feature hashing 이다.
// 그래도 결정적이고, 같은 낱말을 공유하는 문장은 가까운 벡터가 되어 KNN 결과가 의미를 가진다.
// 빈 텍스트는 0 벡터가 된다 — 실제 모델에서도 빈 본문이 이상한 벡터를 만드는 것과 같은 교훈을 재현한다.
import { Vec0KitError } from "../errors.js";
import type { Embedder } from "./types.js";

/** 32비트 FNV-1a 해시 */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function mockEmbed(text: string, dims: number): Float32Array {
  const v = new Float32Array(dims);
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  for (const token of tokens) {
    // 낱말마다 칸 하나를 골라 +1 또는 -1 (부호용 해시를 따로 써서 충돌이 상쇄되게)
    const slot = fnv1a(token) % dims;
    const sign = fnv1a(`#${token}`) & 1 ? 1 : -1;
    v[slot] = (v[slot] ?? 0) + sign;
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < dims; i++) v[i] = v[i]! / norm;
  return v; // 토큰이 없으면 0 벡터 그대로
}

export function createMockEmbedder(opts: { dims: number }): Embedder {
  if (!Number.isInteger(opts.dims) || opts.dims <= 0) {
    throw new Vec0KitError("E_EMBED", `mock embedder needs a positive dims, got ${opts.dims}`, { detail: `dims ${opts.dims}` });
  }
  return {
    id: `mock:feature-hashing:${opts.dims}`,
    dims: opts.dims,
    embed: async (texts) => texts.map((t) => mockEmbed(t, opts.dims)),
  };
}
