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
  embeddingEndpoint: "https://api.openai.com/v1/embeddings",
  apiKey: "",
  model: "text-embedding-3-small",
  similarityThreshold: 0.65,
  clusterCount: 8,
  maxNotes: 500,
  autoIndexOnSave: false,
};
