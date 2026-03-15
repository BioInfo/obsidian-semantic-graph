export interface SemanticGraphSettings {
  embeddingEndpoint: string;
  apiKey: string;
  model: string;
  similarityThreshold: number;
  clusterCount: number;
  maxNotes: number;
  autoIndexOnSave: boolean;
}

export const DEFAULT_SETTINGS: SemanticGraphSettings = {
  embeddingEndpoint: "http://localhost:4001/v1/embeddings",
  apiKey: "",
  model: "all-mpnet-base-v2",
  similarityThreshold: 0.4,
  clusterCount: 8,
  maxNotes: 500,
  autoIndexOnSave: true,
};
