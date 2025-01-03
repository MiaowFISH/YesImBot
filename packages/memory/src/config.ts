import { Schema } from "koishi";

export interface EmbeddingConfig {
  APIType: "OpenAI" | "Custom" | "Ollama";
  BaseURL: string;
  APIKey: string;
  EmbeddingModel: string;
  EmbeddingDims: number;
  ChunkSize: number;
  RequestBody: string;
  GetVecRegex: string;
}

export const EmbeddingConfig: Schema<EmbeddingConfig> = Schema.object({
  APIType: Schema.union(["OpenAI", "Custom", "Ollama"])
    .default("OpenAI")
    .description("Embedding API 类型"),
  BaseURL: Schema.string()
    .default("https://api.openai.com")
    .description("Embedding API 基础 URL"),
  APIKey: Schema.string().description("API 令牌"),
  EmbeddingModel: Schema.string()
    .default("text-embedding-3-large")
    .description("Embedding 模型 ID"),
  EmbeddingDims: Schema.number()
    .default(1536)
    .experimental()
    .description("Embedding 向量维度"),
  ChunkSize: Schema.number()
    .default(300)
    .experimental()
    .description("文本分词长度"),
  RequestBody: Schema.string().description(
    "自定义请求体。<br/>其中：<br/>\
        `<text>`（包含尖括号）会被替换成用于计算嵌入向量的文本；<br/>\
        `<apikey>`（包含尖括号）会被替换成此页面设置的 API 密钥；<br/>\
        `<model>`（包含尖括号）会被替换成此页面设置的模型名称".trim()
  ),
  GetVecRegex: Schema.string().description(
    "从自定义Embedding服务提取嵌入向量的正则表达式。注意转义"
  ),
});

export interface Config {
  embedding: EmbeddingConfig
}

export const Config: Schema<Config> = Schema.object({
  embedding: EmbeddingConfig,
});
