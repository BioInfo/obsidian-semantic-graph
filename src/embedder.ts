import { requestUrl } from "obsidian";
import { SemanticGraphSettings } from "./settings";

export interface EmbedResult {
  path: string;
  vector: number[];
  indexedAt: number;
}

export async function embedTexts(
  texts: string[],
  settings: SemanticGraphSettings
): Promise<number[][]> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (settings.apiKey) {
    headers["Authorization"] = `Bearer ${settings.apiKey}`;
  }

  const response = await requestUrl({
    url: settings.embeddingEndpoint,
    method: "POST",
    headers,
    body: JSON.stringify({
      input: texts,
      model: settings.model,
    }),
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Embedding API error ${response.status}: ${response.text}`);
  }

  return (response.json.data as { embedding: number[] }[]).map((d) => d.embedding);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/** Simple k-means clustering on embedding vectors */
export function kMeansClusters(
  vectors: number[][],
  k: number,
  iterations = 20
): number[] {
  if (vectors.length === 0) return [];
  k = Math.min(k, vectors.length);

  // Init centroids by picking k random vectors
  let centroids = vectors
    .slice()
    .sort(() => Math.random() - 0.5)
    .slice(0, k);

  let assignments = new Array(vectors.length).fill(0);

  for (let iter = 0; iter < iterations; iter++) {
    // Assign each vector to nearest centroid
    for (let i = 0; i < vectors.length; i++) {
      let best = 0, bestSim = -Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const sim = cosineSimilarity(vectors[i], centroids[c]);
        if (sim > bestSim) { bestSim = sim; best = c; }
      }
      assignments[i] = best;
    }

    // Recompute centroids
    const dims = vectors[0].length;
    const newCentroids = Array.from({ length: k }, () => new Array(dims).fill(0));
    const counts = new Array(k).fill(0);
    for (let i = 0; i < vectors.length; i++) {
      const c = assignments[i];
      counts[c]++;
      for (let d = 0; d < dims; d++) newCentroids[c][d] += vectors[i][d];
    }
    for (let c = 0; c < k; c++) {
      if (counts[c] > 0)
        for (let d = 0; d < dims; d++) newCentroids[c][d] /= counts[c];
    }
    centroids = newCentroids;
  }

  return assignments;
}
