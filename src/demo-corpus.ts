// 데모용 짧은 문장 생성기(직접 작성, MIT). 외부 데이터셋을 받지 않는다.
// 주제마다 낱말 묶음이 있어서, 같은 주제 문장은 낱말을 공유한다 → 목 임베더에서도 가까운 벡터가 된다.

export const TOPICS = {
  database: ["sqlite", "index", "query", "table", "rowid", "transaction", "backup", "schema"],
  search: ["vector", "embedding", "neighbor", "distance", "cosine", "recall", "ranking", "similarity"],
  cooking: ["recipe", "garlic", "onion", "oven", "pasta", "sauce", "bake", "salt"],
  travel: ["train", "ticket", "station", "hotel", "map", "airport", "luggage", "route"],
  garden: ["seed", "soil", "water", "tomato", "sunlight", "compost", "harvest", "leaf"],
} as const;

export type Topic = keyof typeof TOPICS;

const TEMPLATES = [
  "notes about {a} and {b} for the {c} checklist",
  "how to pick the right {a} when the {b} is slow",
  "a short guide to {a}, {b} and {c}",
  "why {a} matters more than {b}",
  "common mistakes with {a} and {c}",
];

export interface DemoDoc {
  id: number;
  topic: Topic;
  body: string;
}

/** 결정적으로 n 개 문서를 만든다(같은 n 이면 언제나 같은 결과). */
export function demoDocuments(n: number): DemoDoc[] {
  const topics = Object.keys(TOPICS) as Topic[];
  const docs: DemoDoc[] = [];
  for (let i = 1; i <= n; i++) {
    const topic = topics[i % topics.length]!;
    const words = TOPICS[topic];
    const pick = (offset: number) => words[(i * 7 + offset * 3) % words.length]!;
    const template = TEMPLATES[i % TEMPLATES.length]!;
    const body = template.replace("{a}", pick(0)).replace("{b}", pick(1)).replace("{c}", pick(2));
    docs.push({ id: i, topic, body });
  }
  return docs;
}
