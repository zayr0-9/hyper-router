import type { generateText } from "ai";
import type {
  OpenAIChatLanguageModelOptions,
  OpenAIEmbeddingModelOptions,
  OpenAILanguageModelChatOptions,
  OpenAILanguageModelCompletionOptions,
  OpenAILanguageModelResponsesOptions,
  OpenAIProvider as VercelOpenAIProvider,
  OpenAIProviderSettings,
} from "@ai-sdk/openai";

export type OpenAIVAIApiMode = "auto" | "responses" | "chat" | "completion";

export type OpenAIVAIModelFactory = Parameters<typeof generateText>[0]["model"];

export type OpenAIVAIProviderSpecificOptions =
  | OpenAILanguageModelResponsesOptions
  | OpenAILanguageModelChatOptions
  | OpenAIChatLanguageModelOptions
  | OpenAILanguageModelCompletionOptions
  | OpenAIEmbeddingModelOptions;

export interface OpenAIVAIProviderOptions
  extends Pick<
    OpenAIProviderSettings,
    "apiKey" | "baseURL" | "name" | "organization" | "project" | "headers" | "fetch"
  > {
  provider?: VercelOpenAIProvider;
  api?: OpenAIVAIApiMode;
  maxRetries?: number;
  providerOptions?: OpenAIVAIProviderSpecificOptions;
  generateTextImpl?: typeof generateText;
}

export type OpenAIApiMode = OpenAIVAIApiMode;
export type OpenAIModelFactory = OpenAIVAIModelFactory;
export type OpenAIProviderSpecificOptions = OpenAIVAIProviderSpecificOptions;
export type OpenAIProviderOptions = OpenAIVAIProviderOptions;
