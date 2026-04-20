import type { generateText } from "ai";
import type {
  AmazonBedrockLanguageModelOptions,
  AmazonBedrockProvider,
  AmazonBedrockProviderSettings,
} from "@ai-sdk/amazon-bedrock";

export type AmazonBedrockVAIProviderSpecificOptions = AmazonBedrockLanguageModelOptions;

export interface AmazonBedrockVAIProviderOptions
  extends Pick<
    AmazonBedrockProviderSettings,
    | "region"
    | "apiKey"
    | "accessKeyId"
    | "secretAccessKey"
    | "sessionToken"
    | "baseURL"
    | "headers"
    | "fetch"
    | "credentialProvider"
  > {
  provider?: AmazonBedrockProvider;
  maxRetries?: number;
  providerOptions?: AmazonBedrockVAIProviderSpecificOptions;
  generateTextImpl?: typeof generateText;
}
