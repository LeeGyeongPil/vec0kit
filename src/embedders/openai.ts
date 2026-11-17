// OpenAI 호환 /embeddings 임베더 (로컬 Ollama 의 http://localhost:11434/v1 도 같은 형식).
// 요청: POST {baseUrl}/embeddings  {model, input: [...]}
// 응답: {data: [{index, embedding: number[]}]} — index 순서로 다시 정렬한다(순서가 섞여 와도 안전).
import { Vec0KitError } from "../errors.js";
import type { Embedder } from "./types.js";

export interface OpenAIEmbedderOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** 기대 차원. 다르면 E_EMBED */
  dims?: number;
  /** 요청 하나의 상한. 로컬 모델은 느릴 수 있어 넉넉히(기본 5분) — 느림 자체는 오류가 아니다. */
  timeoutMs?: number;
  /** 네트워크 오류·429·5xx 재시도 횟수 */
  retries?: number;
}

interface EmbeddingResponse {
  data?: { index?: number; embedding?: unknown }[];
}

function embedError(message: string, _kind: string): Vec0KitError {
  return new Vec0KitError("E_EMBED", message, { detail: message });
}

export function createOpenAIEmbedder(opts: OpenAIEmbedderOptions): Embedder {
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/embeddings`;
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const retries = opts.retries ?? 3;

  async function post(texts: string[]): Promise<EmbeddingResponse> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;
    let lastError = "";
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({ model: opts.model, input: texts }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        lastError = (err as Error).message; // 연결 실패·시간 초과 → 재시도
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        lastError = `HTTP ${res.status}`;
        await res.body?.cancel();
        continue;
      }
      if (!res.ok) {
        const body = (await res.text()).slice(0, 300);
        throw embedError(`embedding endpoint returned HTTP ${res.status}: ${body}`, `HTTP ${res.status}`);
      }
      return (await res.json()) as EmbeddingResponse;
    }
    throw embedError(`embedding endpoint failed after ${retries + 1} attempts: ${lastError}`, lastError);
  }

  return {
    id: `openai:${opts.baseUrl}:${opts.model}`,
    ...(opts.dims !== undefined ? { dims: opts.dims } : {}),
    async embed(texts) {
      if (texts.length === 0) return [];
      const json = await post(texts);
      const data = json.data;
      if (!Array.isArray(data) || data.length !== texts.length) {
        throw embedError(`expected ${texts.length} embeddings, got ${Array.isArray(data) ? data.length : "none"}`, "count");
      }
      const out = new Array<Float32Array>(texts.length);
      data.forEach((item, position) => {
        const index = typeof item.index === "number" ? item.index : position;
        const emb = item.embedding;
        if (!Array.isArray(emb) || !emb.every((x) => typeof x === "number")) throw embedError("embedding is not a number array", "shape");
        if (opts.dims !== undefined && emb.length !== opts.dims) {
          throw embedError(`embedding has ${emb.length} dimensions, expected ${opts.dims}`, "dims");
        }
        if (index < 0 || index >= texts.length || out[index]) throw embedError(`bad embedding index ${index}`, "index");
        out[index] = Float32Array.from(emb as number[]);
      });
      return out;
    },
  };
}
