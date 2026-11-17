// 벡터 BLOB 해석: vec0 는 float 을 float32 리틀엔디안, int8 을 바이트, bit 를 비트 묶음으로 저장한다.
import type { ElementType } from "./declaration.js";

export interface VectorStats {
  dims: number;
  /** 모든 요소가 0 — cosine 거리에서 distance 가 NULL 이 되어 KNN 결과를 오염시킨다 */
  isZero: boolean;
  /** NaN 이나 ±Infinity 가 들어 있음(float 만 가능) */
  nonFinite: boolean;
  /** L2 노름(비유한 값이 있으면 NaN) */
  norm: number;
}

/** BLOB → 숫자 배열 보기(복사 없이). bit 는 바이트 배열 그대로 돌려준다. */
export function decodeVector(blob: Uint8Array, elementType: ElementType): Float32Array | Int8Array | Uint8Array {
  if (elementType === "float") {
    // 정렬되지 않은 Buffer 일 수 있어 4바이트 정렬이 아니면 복사한다.
    if (blob.byteOffset % 4 === 0) return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
    return new Float32Array(blob.slice().buffer);
  }
  if (elementType === "int8") return new Int8Array(blob.buffer, blob.byteOffset, blob.byteLength);
  return blob;
}

export function vectorStats(blob: Uint8Array, elementType: ElementType): VectorStats {
  const values = decodeVector(blob, elementType);
  let sumSq = 0;
  let nonFinite = false;
  let isZero = true;
  if (elementType === "bit") {
    // bit: 켜진 비트가 하나도 없으면 0 벡터, 노름 = 켜진 비트 수의 제곱근
    let ones = 0;
    for (const byte of values) {
      let b = byte;
      while (b) {
        ones += b & 1;
        b >>= 1;
      }
    }
    return { dims: values.length * 8, isZero: ones === 0, nonFinite: false, norm: Math.sqrt(ones) };
  }
  for (const x of values) {
    if (!Number.isFinite(x)) nonFinite = true;
    else if (x !== 0) isZero = false;
    sumSq += x * x;
  }
  if (nonFinite) isZero = false;
  return { dims: values.length, isZero, nonFinite, norm: Math.sqrt(sumSq) };
}

/** Float32Array → vec0 에 넣을 BLOB(Buffer). */
export function toBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

/** 임베더가 돌려준 벡터가 쓸 수 있는지(cosine 이면 0 벡터도 거부) */
export function invalidReason(v: Float32Array, cosine: boolean): "non-finite" | "zero-vector" | null {
  let zero = true;
  for (const x of v) {
    if (!Number.isFinite(x)) return "non-finite";
    if (x !== 0) zero = false;
  }
  return zero && cosine ? "zero-vector" : null;
}
