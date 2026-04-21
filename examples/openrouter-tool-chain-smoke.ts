import {
  OpenRouter,
  fromChatMessages,
  tool as openRouterTool,
  type ConversationState,
  type StateAccessor,
} from "@openrouter/agent";
import { z } from "zod/v4";

import {
  createRuntime,
  defineAgent,
  defineTool,
  InMemoryStorage,
  type Message,
  type ModelProvider,
  type ModelResponse,
  type ToolCall,
  type ToolDefinition,
} from "../src/index.js";
import { OpenRouterProvider } from "../src/providers/openrouter/index.js";
import { toInputItems } from "../src/providers/openrouter/items.js";

const MODEL = "openai/gpt-5-mini";

type SmokeCategory = "resume" | "cache";

interface SmokeTestCase {
  id: string;
  category: SmokeCategory;
  description: string;
  selectors?: string[];
  run: () => Promise<void>;
}

interface SelectionOptions {
  only: Set<string> | null;
  listOnly: boolean;
}

interface UsageDetailsLike {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  inputTokensDetails?: {
    cachedTokens?: number;
    cacheWriteTokens?: number;
  };
}

interface ResponseLike {
  id?: string;
  usage?: UsageDetailsLike;
}

interface CacheProbeResult {
  label: string;
  text: string;
  responseId?: string;
  usage?: UsageDetailsLike;
  cachedTokens: number;
  cacheWriteTokens: number;
}

interface ProviderCallTrace {
  callIndex: number;
  sessionId?: string;
  responseId?: string;
  usage?: UsageDetailsLike;
  cachedTokens: number;
  cacheWriteTokens: number;
  inputItemCount: number;
  messageCount: number;
  lastUserMessage?: string;
  text: string;
  toolCalls: ToolCall[];
}

const generateTicketId = defineTool<{ seed: string }, { ticketId: string }>({
  name: "generate_ticket_id",
  description:
    "Generate a ticket ID from a seed string. Use this before calling lookup_ticket.",
  inputSchema: z.object({
    seed: z.string(),
  }),
  async execute(args) {
    const normalizedSeed = args.seed.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "-");

    return {
      ok: true,
      output: {
        ticketId: `${normalizedSeed}-48291`,
      },
    };
  },
});

const lookupTicket = defineTool<
  { ticketId: string },
  { status: string; priority: string; owner: string }
>({
  name: "lookup_ticket",
  description: "Look up ticket details for a previously generated ticket ID.",
  inputSchema: z.object({
    ticketId: z.string(),
  }),
  async execute(args) {
    return {
      ok: true,
      output: {
        status: "open",
        priority: "high",
        owner: `owner-for-${args.ticketId}`,
      },
    };
  },
});

const getWeeklySalesReport = defineTool<
  Record<string, never>,
  {
    week: string;
    shopName: string;
    currency: string;
    rankings: Array<{
      rank: number;
      itemId: string;
      itemName: string;
      unitsSold: number;
      revenue: number;
    }>;
  }
>({
  name: "get_weekly_sales_report",
  description:
    "Fetch the full weekly shop sales ranking. Use this tool exactly once for each weekly best-selling or worst-performing item question before answering.",
  inputSchema: z.object({}),
  async execute() {
    return {
      ok: true,
      output: buildWeeklySalesReport(),
    };
  },
});

const getWeeklySalesReportLarge = defineTool<
  Record<string, never>,
  {
    week: string;
    shopName: string;
    currency: string;
    rankings: Array<{
      rank: number;
      itemId: string;
      itemName: string;
      unitsSold: number;
      revenue: number;
    }>;
    notes: string[];
  }
>({
  name: "get_weekly_sales_report_large",
  description:
    "Fetch the full weekly shop sales ranking plus extensive weekly notes. Use this tool exactly once for each weekly best-selling or worst-performing item question before answering.",
  inputSchema: z.object({}),
  async execute() {
    return {
      ok: true,
      output: buildLargeWeeklySalesReport(),
    };
  },
});

class TranscriptOnlyTraceOpenRouterProvider implements ModelProvider {
  private readonly client: OpenRouter;
  private readonly traces: ProviderCallTrace[] = [];

  constructor(apiKey: string) {
    this.client = new OpenRouter({ apiKey });
  }

  getTraces(): ProviderCallTrace[] {
    return [...this.traces];
  }

  async generate(input: {
    sessionId?: string;
    model: string;
    messages: Message[];
    tools: ToolDefinition<unknown, unknown>[];
  }): Promise<ModelResponse> {
    const toolDefs = input.tools.map((tool) =>
      openRouterTool({
        name: tool.name,
        description: tool.description,
        inputSchema: toZodObjectSchema(tool.inputSchema),
        execute: false,
      }),
    );

    const requestInput = toInputItems(input.messages);
    const callResult = this.client.callModel({
      model: input.model,
      input: requestInput,
      tools: toolDefs,
    });

    const [text, toolCalls, response] = await Promise.all([
      callResult.getText(),
      callResult.getToolCalls(),
      callResult.getResponse(),
    ]);
    const normalizedToolCalls = normalizeToolCalls(toolCalls as Array<{ id?: string; name?: string; arguments?: unknown }>);
    const typedResponse = response as ResponseLike;

    const lastUserMessage = [...input.messages].reverse().find((message) => message.role === "user")?.content;

    this.traces.push({
      callIndex: this.traces.length + 1,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(typedResponse.id ? { responseId: typedResponse.id } : {}),
      ...(typedResponse.usage ? { usage: typedResponse.usage } : {}),
      cachedTokens: readCachedTokens(typedResponse),
      cacheWriteTokens: readCacheWriteTokens(typedResponse),
      inputItemCount: requestInput.length,
      messageCount: input.messages.length,
      ...(lastUserMessage ? { lastUserMessage } : {}),
      text,
      toolCalls: normalizedToolCalls,
    });

    const result: ModelResponse = {
      toolCalls: normalizedToolCalls,
      stopReason: normalizedToolCalls.length > 0 ? "tool_calls" : "completed",
    };

    if (text && text.trim().length > 0) {
      result.message = {
        role: "assistant",
        content: text,
        date: new Date(),
        ...(normalizedToolCalls.length > 0 ? { toolCalls: normalizedToolCalls } : {}),
      };
    } else if (normalizedToolCalls.length > 0) {
      result.message = {
        role: "assistant",
        content: "",
        date: new Date(),
        toolCalls: normalizedToolCalls,
      };
    }

    return result;
  }
}

function simplifyMessage(message: Message) {
  return {
    role: message.role,
    content: message.content,
    ...(message.name ? { name: message.name } : {}),
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    ...(message.toolCalls
      ? {
          toolCalls: message.toolCalls.map((toolCall) => ({
            ...(toolCall.id ? { id: toolCall.id } : {}),
            toolName: toolCall.toolName,
            args: toolCall.args,
          })),
        }
      : {}),
  };
}

function printTranscript(label: string, messages: Message[]): void {
  console.log(`\n${label}`);
  console.log(JSON.stringify(messages.map(simplifyMessage), null, 2));
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function parseSelectionOptions(argv: string[]): SelectionOptions {
  let onlyValue = process.env.OPENROUTER_SMOKE_ONLY?.trim() || null;
  let listOnly = false;

  for (const arg of argv) {
    if (arg === "--list") {
      listOnly = true;
      continue;
    }

    if (arg.startsWith("--only=")) {
      onlyValue = arg.slice("--only=".length).trim();
      continue;
    }
  }

  return {
    only:
      onlyValue && onlyValue.length > 0
        ? new Set(
            onlyValue
              .split(",")
              .map((value) => value.trim())
              .filter(Boolean),
          )
        : null,
    listOnly,
  };
}

function matchesSelection(testCase: SmokeTestCase, selection: SelectionOptions): boolean {
  if (!selection.only || selection.only.size === 0) {
    return true;
  }

  return (
    selection.only.has(testCase.id) ||
    selection.only.has(testCase.category) ||
    (testCase.selectors?.some((selector) => selection.only?.has(selector)) ?? false)
  );
}

function printAvailableTests(testCases: SmokeTestCase[]): void {
  console.log("Available smoke tests:\n");
  for (const testCase of testCases) {
    console.log(`- ${testCase.id} [category=${testCase.category}]`);
    console.log(`  ${testCase.description}`);
  }

  console.log("\nExamples:");
  console.log("- npm run smoke:openrouter:chain");
  console.log("- npm run smoke:openrouter:chain -- --only=resume");
  console.log("- npm run smoke:openrouter:chain -- --only=cache");
  console.log("- npm run smoke:openrouter:chain -- --only=transcript-cache");
  console.log("- npm run smoke:openrouter:chain -- --only=state-accessor-cache");
  console.log("- OPENROUTER_SMOKE_ONLY=transcript-cache npm run smoke:openrouter:chain");
}

function assertFirstRunTranscriptShape(messages: Message[]): void {
  assert(messages.length >= 3, `Expected at least 3 transcript messages after first run, got ${messages.length}.`);
  assert(
    messages.every((message) => message.role !== "system"),
    "Persisted transcript should not contain system messages.",
  );

  const firstUser = messages[0];
  const firstAssistant = messages[1];
  const firstTool = messages[2];

  assert(firstUser?.role === "user", "Expected first persisted transcript message to be the user prompt.");
  assert(
    firstAssistant?.role === "assistant",
    "Expected second persisted transcript message to be the assistant tool-call message.",
  );
  assert(firstTool?.role === "tool", "Expected third persisted transcript message to be a tool result.");

  const firstAssistantToolCall = firstAssistant.toolCalls?.[0];
  assert(firstAssistantToolCall, "Expected first assistant message to include a tool call.");
  assert(
    firstAssistantToolCall.toolName === "generate_ticket_id",
    `Expected first tool call to be generate_ticket_id, got ${firstAssistantToolCall.toolName}.`,
  );
  assert(
    firstTool.name === "generate_ticket_id",
    `Expected first tool result to be generate_ticket_id, got ${firstTool.name ?? "<none>"}.`,
  );
  assert(
    firstTool.toolCallId === firstAssistantToolCall.id,
    "Expected persisted toolCallId to match the assistant tool call id for generate_ticket_id.",
  );
}

function assertCompletedTranscriptShape(messages: Message[]): void {
  assert(messages.length >= 6, `Expected at least 6 transcript messages after resume, got ${messages.length}.`);

  const toolMessages = messages.filter((message) => message.role === "tool");
  assert(toolMessages.length >= 2, `Expected at least 2 tool messages after resume, got ${toolMessages.length}.`);

  const toolNames = toolMessages.map((message) => message.name ?? "");
  const generateIndex = toolNames.indexOf("generate_ticket_id");
  const lookupIndex = toolNames.indexOf("lookup_ticket");

  assert(generateIndex !== -1, "Expected generate_ticket_id tool result in resumed transcript.");
  assert(lookupIndex !== -1, "Expected lookup_ticket tool result in resumed transcript.");
  assert(
    generateIndex < lookupIndex,
    `Expected generate_ticket_id before lookup_ticket, got order ${toolNames.join(", ")}.`,
  );

  const firstGenerateToolMessage = toolMessages[generateIndex];
  const firstLookupToolMessage = toolMessages[lookupIndex];

  const parsedGenerateResult = JSON.parse(firstGenerateToolMessage?.content ?? "{}") as {
    output?: { ticketId?: string };
  };
  const parsedLookupResult = JSON.parse(firstLookupToolMessage?.content ?? "{}") as {
    output?: { owner?: string };
  };
  const generatedTicketId = parsedGenerateResult.output?.ticketId;

  assert(generatedTicketId, "Expected generate_ticket_id tool output to contain ticketId.");
  assert(
    parsedLookupResult.output?.owner === `owner-for-${generatedTicketId}`,
    "Expected lookup_ticket to use the exact previously generated ticketId.",
  );

  const lookupAssistantMessage = messages.find(
    (message) =>
      message.role === "assistant" &&
      (message.toolCalls?.some((toolCall) => toolCall.toolName === "lookup_ticket") ?? false),
  );
  const lookupAssistantToolCall = lookupAssistantMessage?.toolCalls?.find(
    (toolCall) => toolCall.toolName === "lookup_ticket",
  );

  assert(lookupAssistantToolCall, "Expected resumed transcript to contain assistant lookup_ticket tool call.");
  assert(
    firstLookupToolMessage?.toolCallId === lookupAssistantToolCall.id,
    "Expected persisted lookup_ticket toolCallId to match the assistant tool call id.",
  );

  const finalAssistantMessage = [...messages]
    .reverse()
    .find((message) => message.role === "assistant" && (!message.toolCalls || message.toolCalls.length === 0));

  assert(finalAssistantMessage?.content.trim(), "Expected a final assistant summary after resumed tool chain.");
}

function buildLargeStableReferenceBlob(sectionCount = 110): string {
  return [
    "REFERENCE DOSSIER START",
    ...Array.from({ length: sectionCount }, (_, index) => {
      const itemNumber = index + 1;
      return (
        `Section ${itemNumber}: Preserve transcript ordering, tool-call identity, ` +
        `argument fidelity, tool-result linkage, and exact block sequencing ` +
        `for cache-sensitivity experiments across resumed conversations.`
      );
    }),
    "REFERENCE DOSSIER END",
    "After reading the dossier, answer the user question briefly and do not quote the dossier verbatim.",
  ].join("\n");
}

function buildExactCacheMessages(stableReference: string, question: string) {
  return [
    {
      role: "system" as const,
      content: "You are a concise assistant. Use the reference dossier as background context.",
    },
    {
      role: "user" as const,
      content: stableReference,
    },
    {
      role: "user" as const,
      content: question,
    },
  ];
}

function buildReshapedCacheMessages(stableReference: string, question: string) {
  const midpoint = Math.floor(stableReference.length / 2);
  const splitIndex = stableReference.indexOf("\n", midpoint);
  const safeSplitIndex = splitIndex === -1 ? midpoint : splitIndex;
  const firstHalf = stableReference.slice(0, safeSplitIndex);
  const secondHalf = stableReference.slice(safeSplitIndex + 1);

  return [
    {
      role: "system" as const,
      content: "You are a concise assistant. Use the reference dossier as background context.",
    },
    {
      role: "user" as const,
      content: firstHalf,
    },
    {
      role: "user" as const,
      content: secondHalf,
    },
    {
      role: "user" as const,
      content: question,
    },
  ];
}

function buildWeeklySalesReport() {
  return {
    week: "2025-W16",
    shopName: "Northwind Corner Shop",
    currency: "USD",
    rankings: [
      { rank: 1, itemId: "sku-cold-brew", itemName: "Cold Brew Bottle", unitsSold: 184, revenue: 1104 },
      { rank: 2, itemId: "sku-matcha-cookie", itemName: "Matcha Cookie Box", unitsSold: 152, revenue: 912 },
      { rank: 3, itemId: "sku-oat-bar", itemName: "Oat Energy Bar", unitsSold: 131, revenue: 524 },
      { rank: 4, itemId: "sku-vanilla-granola", itemName: "Vanilla Granola Bag", unitsSold: 97, revenue: 679 },
      { rank: 5, itemId: "sku-berry-jam", itemName: "Berry Jam Jar", unitsSold: 63, revenue: 441 },
      { rank: 6, itemId: "sku-lemon-tonic", itemName: "Lemon Tonic Can", unitsSold: 41, revenue: 164 },
      { rank: 7, itemId: "sku-spice-tea", itemName: "Spiced Tea Tin", unitsSold: 24, revenue: 288 },
      { rank: 8, itemId: "sku-cocoa-mix", itemName: "Cocoa Mix Packet", unitsSold: 11, revenue: 66 },
    ],
  };
}

function buildRetailAnalyticsSystemPrompt(sectionCount = 140): string {
  return [
    "You are a retail analytics assistant for Northwind Corner Shop.",
    "You must use tools for weekly sales ranking questions, preserve numeric fidelity, and answer briefly.",
    "REFERENCE MANUAL START",
    ...Array.from({ length: sectionCount }, (_, index) => {
      const itemNumber = index + 1;
      return (
        `Policy ${itemNumber}: Preserve transcript ordering, tool-call identity, exact tool result fidelity, ` +
        `weekly ranking consistency, and deterministic phrasing for repeated sales-analysis turns.`
      );
    }),
    "REFERENCE MANUAL END",
    "When the user asks for the best-selling or worst-performing weekly item, call get_weekly_sales_report exactly once for that turn before answering.",
    "Never invent units sold, revenue, item ids, or item names.",
    "Keep the final answer to one sentence.",
  ].join("\n");
}

function buildLargeWeeklySalesReport() {
  return {
    ...buildWeeklySalesReport(),
    notes: Array.from({ length: 180 }, (_, index) => {
      const itemNumber = index + 1;
      return (
        `Weekly note ${itemNumber}: Preserve weekly sales ranking fidelity for Northwind Corner Shop, ` +
        `including stable item ordering, exact units sold, exact revenue, and repeated analytics wording for transcript-cache probe E.`
      );
    }),
  };
}

function toZodObjectSchema(inputSchema: unknown) {
  if (inputSchema && typeof inputSchema === "object") {
    return inputSchema as z.ZodObject<any>;
  }

  return z.object({}).passthrough();
}

function normalizeToolCalls(toolCalls: Array<{ id?: string; name?: string; arguments?: unknown }>): ToolCall[] {
  return toolCalls.map((toolCall) => ({
    ...(toolCall.id ? { id: toolCall.id } : {}),
    toolName: String(toolCall.name ?? "unknown_tool"),
    args: toolCall.arguments ?? {},
  }));
}

function printProviderCallTraces(label: string, traces: ProviderCallTrace[]): void {
  console.log(`\n${label}`);
  console.log(
    JSON.stringify(
      traces.map((trace) => ({
        callIndex: trace.callIndex,
        ...(trace.sessionId ? { sessionId: trace.sessionId } : {}),
        ...(trace.responseId ? { responseId: trace.responseId } : {}),
        cachedTokens: trace.cachedTokens,
        cacheWriteTokens: trace.cacheWriteTokens,
        inputItemCount: trace.inputItemCount,
        messageCount: trace.messageCount,
        ...(trace.lastUserMessage ? { lastUserMessage: trace.lastUserMessage } : {}),
        toolCalls: trace.toolCalls.map((toolCall) => ({
          ...(toolCall.id ? { id: toolCall.id } : {}),
          toolName: toolCall.toolName,
          args: toolCall.args,
        })),
        usage: trace.usage ?? {},
        text: trace.text,
      })),
      null,
      2,
    ),
  );
}

function readCachedTokens(response: ResponseLike): number {
  return (
    response.usage?.inputTokensDetails?.cachedTokens ??
    response.usage?.prompt_tokens_details?.cached_tokens ??
    0
  );
}

function readCacheWriteTokens(response: ResponseLike): number {
  return (
    response.usage?.inputTokensDetails?.cacheWriteTokens ??
    response.usage?.prompt_tokens_details?.cache_write_tokens ??
    0
  );
}

function printCacheProbeResult(result: CacheProbeResult): void {
  console.log(`\n${result.label}`);
  console.log(`- response id: ${result.responseId ?? "<unknown>"}`);
  console.log(`- cached tokens: ${result.cachedTokens}`);
  console.log(`- cache write tokens: ${result.cacheWriteTokens}`);
  console.log(`- usage: ${JSON.stringify(result.usage ?? {}, null, 2)}`);
  console.log(`- text: ${result.text.trim() || "<empty>"}`);
}

async function runCacheProbe(
  client: OpenRouter,
  label: string,
  messages: Array<{ role: "system" | "user"; content: string }>,
): Promise<CacheProbeResult> {
  const result = client.callModel({
    model: MODEL,
    input: fromChatMessages(messages) as never,
  });

  const [text, response] = await Promise.all([result.getText(), result.getResponse()]);
  const typedResponse = response as ResponseLike;

  return {
    label,
    text,
    ...(typedResponse.id ? { responseId: typedResponse.id } : {}),
    ...(typedResponse.usage ? { usage: typedResponse.usage } : {}),
    cachedTokens: readCachedTokens(typedResponse),
    cacheWriteTokens: readCacheWriteTokens(typedResponse),
  };
}

async function runResumeSmoke(): Promise<void> {
  console.log("Running OpenRouter transcript-resume multi-tool chain smoke test...");

  const sessionId = "openrouter-tool-chain-smoke-resume";
  const storage = new InMemoryStorage();

  const agent = defineAgent({
    name: "openrouter-tool-chain-smoke",
    instructions:
      "You are a careful tool-calling assistant. When the user gives a required sequence of tools, you must follow it exactly, preserve dependencies between tool calls, and wait for each dependent tool result before issuing the next tool call.",
    model: MODEL,
    tools: [generateTicketId, lookupTicket],
    buildMessages: (input) =>
      input.trim().length === 0 ? [] : [{ role: "user", content: input, date: new Date() }],
  });

  const prompt =
    "You must do the following in order: (1) call generate_ticket_id with seed='chain-test', (2) after receiving the returned ticketId, call lookup_ticket with that exact returned ticketId, and (3) then give a one-sentence summary. Do not skip any tool calls, do not invent the ticketId, and do not call lookup_ticket before the generate_ticket_id result is available.";

  console.log("\nPhase 1: start a fresh runtime, stop after the first tool step, and persist transcript only.");

  const runtimeA = createRuntime({
    agent,
    provider: new OpenRouterProvider(),
    storage,
  });

  const firstRun = await runtimeA.run({
    sessionId,
    input: prompt,
    maxSteps: 1,
  });

  console.log("First run status:", firstRun.status);
  const persistedTranscriptAfterFirstRun = await storage.loadMessages(sessionId);
  printTranscript("Persisted transcript after first run:", persistedTranscriptAfterFirstRun);

  assert(
    firstRun.status === "max_steps_reached",
    `Expected first run to stop at max_steps_reached, got '${firstRun.status}'.`,
  );
  assertFirstRunTranscriptShape(persistedTranscriptAfterFirstRun);

  console.log("\nPhase 2: create a fresh runtime and fresh OpenRouter provider, reload transcript from memory, and continue.");

  const runtimeB = createRuntime({
    agent,
    provider: new OpenRouterProvider(),
    storage,
  });

  const secondRun = await runtimeB.run({
    sessionId,
    input: "",
    maxSteps: 6,
  });

  console.log("Second run status:", secondRun.status);
  const persistedTranscriptAfterSecondRun = await storage.loadMessages(sessionId);
  printTranscript("Persisted transcript after resumed run:", persistedTranscriptAfterSecondRun);

  assert(
    secondRun.status === "completed",
    `Expected resumed run to complete, got '${secondRun.status}'.`,
  );

  const firstRunPrefix = JSON.stringify(persistedTranscriptAfterFirstRun.map(simplifyMessage));
  const resumedPrefix = JSON.stringify(
    persistedTranscriptAfterSecondRun.slice(0, persistedTranscriptAfterFirstRun.length).map(simplifyMessage),
  );

  assert(
    firstRunPrefix === resumedPrefix,
    "Expected resumed transcript to preserve the exact persisted prefix from the first run.",
  );
  assertCompletedTranscriptShape(persistedTranscriptAfterSecondRun);

  console.log("\nObservations:");
  console.log("- Transcript-only resume worked with a fresh runtime and a fresh OpenRouter provider instance.");
  console.log("- Persisted assistant tool-call messages and tool results preserved order and toolCallId linkage.");
  console.log(
    "- This smoke test does not prove provider-native cache continuity, but it does verify the transcript shape needed for later cache-sensitivity checks.",
  );

  console.log("\n✅ Resume smoke test passed.");
}

async function runCacheSmoke(): Promise<void> {
  console.log("Running OpenRouter prompt-cache sensitivity probe...");

  const apiKey = process.env.OPENROUTER_API_KEY;
  assert(apiKey, "Missing OPENROUTER_API_KEY. Set it before running this script.");

  const client = new OpenRouter({ apiKey });
  const stableReference = buildLargeStableReferenceBlob();

  console.log(`Stable reference length: ${stableReference.length} characters.`);
  console.log(
    "This probe compares an exact repeated prefix versus a reshaped-but-similar prefix to inspect cache sensitivity.",
  );

  const warmup = await runCacheProbe(
    client,
    "Cache probe A: warmup request with exact prefix",
    buildExactCacheMessages(
      stableReference,
      "Question A: In one short sentence, say the dossier was loaded and mention transcript fidelity.",
    ),
  );
  printCacheProbeResult(warmup);

  const exactFollowup = await runCacheProbe(
    client,
    "Cache probe B: follow-up with the exact same opening structure",
    buildExactCacheMessages(
      stableReference,
      "Question B: In one short sentence, explain why preserving early prompt structure may help cache reuse.",
    ),
  );
  printCacheProbeResult(exactFollowup);

  const reshapedFollowup = await runCacheProbe(
    client,
    "Cache probe C: follow-up with reshaped opening structure",
    buildReshapedCacheMessages(
      stableReference,
      "Question C: In one short sentence, explain why reshaping the opening transcript may affect cache reuse.",
    ),
  );
  printCacheProbeResult(reshapedFollowup);

  console.log("\nCache probe observations:");
  console.log(`- Exact follow-up cached tokens: ${exactFollowup.cachedTokens}`);
  console.log(`- Reshaped follow-up cached tokens: ${reshapedFollowup.cachedTokens}`);

  if (exactFollowup.cachedTokens > 0) {
    console.log("- Exact follow-up produced a non-zero cache read, so the prompt was cache-eligible.");
  } else {
    console.log(
      "- Exact follow-up produced zero cached tokens. This is inconclusive rather than a failure; provider routing, thresholds, or model behavior may have prevented a visible cache hit.",
    );
  }

  if (exactFollowup.cachedTokens > reshapedFollowup.cachedTokens) {
    console.log("- Reshaping the opening lowered cache reuse, suggesting structure/order sensitivity.");
  } else if (exactFollowup.cachedTokens === reshapedFollowup.cachedTokens) {
    console.log("- Exact and reshaped follow-ups showed the same cache-read count in this run.");
  } else {
    console.log("- Reshaped follow-up reported more cached tokens than the exact follow-up in this run.");
  }

  console.log("\n✅ Cache probe completed (inspect cached token counts above).");
}

async function runTranscriptConversationCacheSmoke(): Promise<void> {
  console.log("Running OpenRouter transcript-resume agent conversation cache probe...");

  const apiKey = process.env.OPENROUTER_API_KEY;
  assert(apiKey, "Missing OPENROUTER_API_KEY. Set it before running this script.");

  const storage = new InMemoryStorage();
  const sessionId = "openrouter-transcript-conversation-cache";
  const providerA = new TranscriptOnlyTraceOpenRouterProvider(apiKey);
  const providerB = new TranscriptOnlyTraceOpenRouterProvider(apiKey);
  const analyticsSystemPrompt = buildRetailAnalyticsSystemPrompt();

  const agent = defineAgent({
    name: "openrouter-transcript-conversation-cache",
    instructions: analyticsSystemPrompt,
    model: MODEL,
    tools: [getWeeklySalesReport],
    buildMessages: (input) =>
      input.trim().length === 0 ? [] : [{ role: "user", content: input, date: new Date() }],
  });

  console.log(`System prompt length for transcript conversation probe: ${analyticsSystemPrompt.length} characters.`);
  console.log("\nPhase 1: ask for the best-selling item this week and persist transcript only.");
  const runtimeA = createRuntime({
    agent,
    provider: providerA,
    storage,
  });

  const firstRun = await runtimeA.run({
    sessionId,
    input: "What item sold best this week in our shop?",
    maxSteps: 4,
  });
  assert(firstRun.status === "completed", `Expected first run to complete, got '${firstRun.status}'.`);

  const transcriptAfterFirstRun = await storage.loadMessages(sessionId);
  printTranscript("Persisted transcript after first shop question:", transcriptAfterFirstRun);
  printProviderCallTraces("Provider traces for phase 1:", providerA.getTraces());

  const phaseOneTraces = providerA.getTraces();
  assert(phaseOneTraces.length >= 2, `Expected at least 2 provider calls in phase 1, got ${phaseOneTraces.length}.`);
  assert(
    phaseOneTraces.some((trace) => trace.toolCalls.some((toolCall) => toolCall.toolName === "get_weekly_sales_report")),
    "Expected phase 1 provider trace to include a get_weekly_sales_report tool call.",
  );
  assert(
    /Cold Brew Bottle/i.test(transcriptAfterFirstRun[transcriptAfterFirstRun.length - 1]?.content ?? ""),
    "Expected first answer to mention Cold Brew Bottle as the best-selling item.",
  );

  console.log("\nPhase 2: create a fresh runtime/provider, reload transcript only, and ask for the worst-performing item.");
  const runtimeB = createRuntime({
    agent,
    provider: providerB,
    storage,
  });

  const secondRun = await runtimeB.run({
    sessionId,
    input: "Which was the worst performing item?",
    maxSteps: 4,
  });
  assert(secondRun.status === "completed", `Expected second run to complete, got '${secondRun.status}'.`);

  const transcriptAfterSecondRun = await storage.loadMessages(sessionId);
  printTranscript("Persisted transcript after resumed shop conversation:", transcriptAfterSecondRun);
  printProviderCallTraces("Provider traces for phase 2:", providerB.getTraces());

  const phaseTwoTraces = providerB.getTraces();
  assert(phaseTwoTraces.length >= 2, `Expected at least 2 provider calls in phase 2, got ${phaseTwoTraces.length}.`);
  assert(
    phaseTwoTraces.some((trace) => trace.toolCalls.some((toolCall) => toolCall.toolName === "get_weekly_sales_report")),
    "Expected phase 2 provider trace to include a get_weekly_sales_report tool call.",
  );
  assert(
    /Cocoa Mix Packet/i.test(transcriptAfterSecondRun[transcriptAfterSecondRun.length - 1]?.content ?? ""),
    "Expected resumed answer to mention Cocoa Mix Packet as the worst-performing item.",
  );

  const finalPhaseTwoTrace = [...phaseTwoTraces].reverse().find((trace) => trace.toolCalls.length === 0);
  assert(finalPhaseTwoTrace, "Expected a final non-tool provider call trace in phase 2.");

  console.log("\nTranscript conversation cache probe observations:");
  console.log(`- Phase 1 final call cached tokens: ${phaseOneTraces[phaseOneTraces.length - 1]?.cachedTokens ?? 0}`);
  console.log(`- Phase 2 final resumed call cached tokens: ${finalPhaseTwoTrace.cachedTokens}`);
  console.log(
    `- Phase 2 final resumed call response id: ${finalPhaseTwoTrace.responseId ?? "<unknown>"}`,
  );

  if (finalPhaseTwoTrace.cachedTokens > 0) {
    console.log(
      "- The resumed transcript-only conversation preserved enough prefix structure for visible cache reuse on the follow-up agent turn.",
    );
  } else {
    console.log(
      "- The resumed transcript-only conversation completed, but the final follow-up call showed zero visible cached tokens in this run.",
    );
  }

  console.log("\n✅ Transcript conversation cache probe completed.");
}

async function runTranscriptConversationLargeToolCacheSmoke(): Promise<void> {
  console.log("Running OpenRouter transcript-resume large-tool-output cache probe...");

  const apiKey = process.env.OPENROUTER_API_KEY;
  assert(apiKey, "Missing OPENROUTER_API_KEY. Set it before running this script.");

  const storage = new InMemoryStorage();
  const sessionId = "openrouter-transcript-conversation-large-tool-cache";
  const providerA = new TranscriptOnlyTraceOpenRouterProvider(apiKey);
  const providerB = new TranscriptOnlyTraceOpenRouterProvider(apiKey);

  const agent = defineAgent({
    name: "openrouter-transcript-conversation-large-tool-cache",
    instructions:
      "You are a retail analytics assistant. For weekly sales questions, always call get_weekly_sales_report_large before answering. Use the returned ranking exactly as provided, do not invent sales numbers, and answer in one concise sentence.",
    model: MODEL,
    tools: [getWeeklySalesReportLarge],
    buildMessages: (input) =>
      input.trim().length === 0 ? [] : [{ role: "user", content: input, date: new Date() }],
  });

  console.log("System prompt length for large-tool-output probe: short/minimal by design.");
  console.log("\nPhase 1: ask for the best-selling item this week and persist transcript only.");
  const runtimeA = createRuntime({
    agent,
    provider: providerA,
    storage,
  });

  const firstRun = await runtimeA.run({
    sessionId,
    input: "What item sold best this week in our shop?",
    maxSteps: 4,
  });
  assert(firstRun.status === "completed", `Expected first run to complete, got '${firstRun.status}'.`);

  const transcriptAfterFirstRun = await storage.loadMessages(sessionId);
  printTranscript("Persisted transcript after first large-tool shop question:", transcriptAfterFirstRun);
  printProviderCallTraces("Provider traces for large-tool phase 1:", providerA.getTraces());

  const phaseOneTraces = providerA.getTraces();
  assert(phaseOneTraces.length >= 2, `Expected at least 2 provider calls in large-tool phase 1, got ${phaseOneTraces.length}.`);
  assert(
    phaseOneTraces.some((trace) => trace.toolCalls.some((toolCall) => toolCall.toolName === "get_weekly_sales_report_large")),
    "Expected large-tool phase 1 provider trace to include a get_weekly_sales_report_large tool call.",
  );
  assert(
    /Cold Brew Bottle/i.test(transcriptAfterFirstRun[transcriptAfterFirstRun.length - 1]?.content ?? ""),
    "Expected first large-tool answer to mention Cold Brew Bottle as the best-selling item.",
  );

  console.log("\nPhase 2: create a fresh runtime/provider, reload transcript only, and ask for the worst-performing item.");
  const runtimeB = createRuntime({
    agent,
    provider: providerB,
    storage,
  });

  const secondRun = await runtimeB.run({
    sessionId,
    input: "Which was the worst performing item?",
    maxSteps: 4,
  });
  assert(secondRun.status === "completed", `Expected second run to complete, got '${secondRun.status}'.`);

  const transcriptAfterSecondRun = await storage.loadMessages(sessionId);
  printTranscript("Persisted transcript after resumed large-tool shop conversation:", transcriptAfterSecondRun);
  printProviderCallTraces("Provider traces for large-tool phase 2:", providerB.getTraces());

  const phaseTwoTraces = providerB.getTraces();
  assert(phaseTwoTraces.length >= 2, `Expected at least 2 provider calls in large-tool phase 2, got ${phaseTwoTraces.length}.`);
  assert(
    phaseTwoTraces.some((trace) => trace.toolCalls.some((toolCall) => toolCall.toolName === "get_weekly_sales_report_large")),
    "Expected large-tool phase 2 provider trace to include a get_weekly_sales_report_large tool call.",
  );
  assert(
    /Cocoa Mix Packet/i.test(transcriptAfterSecondRun[transcriptAfterSecondRun.length - 1]?.content ?? ""),
    "Expected resumed large-tool answer to mention Cocoa Mix Packet as the worst-performing item.",
  );

  const finalPhaseTwoTrace = [...phaseTwoTraces].reverse().find((trace) => trace.toolCalls.length === 0);
  assert(finalPhaseTwoTrace, "Expected a final non-tool provider call trace in large-tool phase 2.");

  console.log("\nLarge-tool transcript conversation cache probe observations:");
  console.log(`- Phase 1 final call cached tokens: ${phaseOneTraces[phaseOneTraces.length - 1]?.cachedTokens ?? 0}`);
  console.log(`- Phase 2 final resumed call cached tokens: ${finalPhaseTwoTrace.cachedTokens}`);
  console.log(
    `- Phase 2 final resumed call response id: ${finalPhaseTwoTrace.responseId ?? "<unknown>"}`,
  );

  if (finalPhaseTwoTrace.cachedTokens > 0) {
    console.log(
      "- The resumed transcript-only conversation preserved enough structure for visible cache reuse using large tool outputs as the cacheable prefix.",
    );
  } else {
    console.log(
      "- The resumed transcript-only conversation completed, but the final follow-up call showed zero visible cached tokens in this large-tool-output run.",
    );
  }

  console.log("\n✅ Large-tool transcript conversation cache probe completed.");
}

async function main(): Promise<void> {
  const testCases: SmokeTestCase[] = [
    {
      id: "resume-transcript-tool-chain",
      category: "resume",
      description: "Persist transcript in memory, create a fresh runtime/provider, and continue the tool chain.",
      run: runResumeSmoke,
    },
    {
      id: "cache-prefix-sensitivity",
      category: "cache",
      description: "Probe prompt caching with a large stable prefix, then compare exact versus reshaped follow-ups.",
      selectors: ["transcript-cache", "cache-transcript"],
      run: runCacheSmoke,
    },
    {
      id: "cache-state-accessor-tool-chain",
      category: "cache",
      description: "Reuse one in-memory StateAccessor across turns for a large continuous tool chain and inspect cache metrics.",
      selectors: ["state-accessor-cache", "cache-state-accessor"],
      run: runStateAccessorCacheSmoke,
    },
    {
      id: "cache-transcript-shop-conversation",
      category: "cache",
      description: "Ask a best-seller question, persist transcript only, then resume with a worst-performer question and inspect cache reuse on the resumed agent conversation.",
      selectors: ["transcript-conversation-cache", "probe-d", "cache-probe-d"],
      run: runTranscriptConversationCacheSmoke,
    },
    {
      id: "cache-transcript-shop-conversation-large-tool-output",
      category: "cache",
      description: "Ask a best-seller question, persist transcript only, then resume with a worst-performer question where large tool results provide the cacheable prefix instead of a large system prompt.",
      selectors: ["probe-e", "cache-probe-e", "transcript-large-tool-cache"],
      run: runTranscriptConversationLargeToolCacheSmoke,
    },
  ];

  const selection = parseSelectionOptions(process.argv.slice(2));
  if (selection.listOnly) {
    printAvailableTests(testCases);
    return;
  }

  const selectedTests = testCases.filter((testCase) => matchesSelection(testCase, selection));
  assert(selectedTests.length > 0, "No smoke tests matched the requested selection.");

  console.log(`Running ${selectedTests.length} smoke test(s)...`);

  for (const testCase of selectedTests) {
    console.log(`\n=== ${testCase.id} [category=${testCase.category}] ===`);
    await testCase.run();
  }

  console.log("\n🎉 Selected OpenRouter smoke tests finished successfully.");
}

main().catch((error) => {
  console.error("❌ OpenRouter smoke test execution failed.");
  console.error(error);
  process.exitCode = 1;
});

async function runStateAccessorCacheSmoke(): Promise<void> {
  console.log("Running OpenRouter StateAccessor continuity cache probe...");

  const apiKey = process.env.OPENROUTER_API_KEY;
  assert(apiKey, "Missing OPENROUTER_API_KEY. Set it before running this script.");

  const client = new OpenRouter({ apiKey });
  const stableReference = buildLargeStableReferenceBlob(140);
  const conversationId = "cache-state-accessor-tool-chain";
  const stateStore = new Map<string, ConversationState>();

  const state: StateAccessor = {
    load: async () => stateStore.get(conversationId) ?? null,
    save: async (conversationState) => {
      stateStore.set(conversationId, conversationState as ConversationState);
    },
  };

  const generateTicketTool = openRouterTool({
    name: "generate_ticket_id",
    description: "Generate a ticket ID from a seed string.",
    inputSchema: z.object({
      seed: z.string(),
    }),
    execute: async ({ seed }) => {
      const normalizedSeed = seed.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "-");
      return {
        ticketId: `${normalizedSeed}-48291`,
      };
    },
  });

  const lookupTicketTool = openRouterTool({
    name: "lookup_ticket",
    description: "Look up ticket details for a previously generated ticket ID.",
    inputSchema: z.object({
      ticketId: z.string(),
    }),
    execute: async ({ ticketId }) => ({
      status: "open",
      priority: "high",
      owner: `owner-for-${ticketId}`,
    }),
  });

  console.log(`Stable reference length: ${stableReference.length} characters.`);
  console.log(
    "This probe keeps a single provider-native StateAccessor alive across turns and continues one tool chain without transcript persistence.",
  );

  const firstTurn = client.callModel({
    model: MODEL,
    state,
    tools: [generateTicketTool, lookupTicketTool] as const,
    input: fromChatMessages([
      {
        role: "system",
        content:
          "You are a careful assistant. Use the large reference as persistent background context across turns.",
      },
      {
        role: "user",
        content: stableReference,
      },
      {
        role: "user",
        content:
          "Step 1 only: call generate_ticket_id with seed='state-cache-chain', then respond with the generated ticket id and the exact phrase READY-FOR-LOOKUP. Do not call lookup_ticket yet.",
      },
    ]) as never,
  });

  const [firstTurnText, firstTurnResponse] = await Promise.all([
    firstTurn.getText(),
    firstTurn.getResponse(),
  ]);
  const firstTurnTypedResponse = firstTurnResponse as ResponseLike;

  const firstTurnResult: CacheProbeResult = {
    label: "StateAccessor probe A: first turn with large prefix and generate_ticket_id",
    text: firstTurnText,
    ...(firstTurnTypedResponse.id ? { responseId: firstTurnTypedResponse.id } : {}),
    ...(firstTurnTypedResponse.usage ? { usage: firstTurnTypedResponse.usage } : {}),
    cachedTokens: readCachedTokens(firstTurnTypedResponse),
    cacheWriteTokens: readCacheWriteTokens(firstTurnTypedResponse),
  };
  printCacheProbeResult(firstTurnResult);

  assert(
    /READY-FOR-LOOKUP/i.test(firstTurnText),
    "Expected first turn to end with READY-FOR-LOOKUP so the chain can continue on the next turn.",
  );

  const secondTurn = client.callModel({
    model: MODEL,
    state,
    tools: [generateTicketTool, lookupTicketTool] as const,
    input: fromChatMessages([
      {
        role: "user",
        content:
          "Step 2: now call lookup_ticket with the exact previously generated ticket id and give a one-sentence summary. Do not regenerate the ticket id.",
      },
    ]) as never,
  });

  const [secondTurnText, secondTurnResponse] = await Promise.all([
    secondTurn.getText(),
    secondTurn.getResponse(),
  ]);
  const secondTurnTypedResponse = secondTurnResponse as ResponseLike;

  const secondTurnResult: CacheProbeResult = {
    label: "StateAccessor probe B: continued turn on the same StateAccessor",
    text: secondTurnText,
    ...(secondTurnTypedResponse.id ? { responseId: secondTurnTypedResponse.id } : {}),
    ...(secondTurnTypedResponse.usage ? { usage: secondTurnTypedResponse.usage } : {}),
    cachedTokens: readCachedTokens(secondTurnTypedResponse),
    cacheWriteTokens: readCacheWriteTokens(secondTurnTypedResponse),
  };
  printCacheProbeResult(secondTurnResult);

  const loadedState = await state.load();
  console.log("\nLoaded ConversationState summary after second turn:");
  console.log(
    JSON.stringify(
      {
        id: loadedState?.id,
        status: loadedState?.status,
        messageCount: Array.isArray(loadedState?.messages)
          ? loadedState?.messages.length
          : loadedState?.messages
            ? 1
            : 0,
        updatedAt: loadedState?.updatedAt,
      },
      null,
      2,
    ),
  );

  assert(/owner-for-STATE-CACHE-CHAIN-48291/i.test(secondTurnText), "Expected second turn summary to mention the looked-up owner.");

  console.log("\nStateAccessor cache probe observations:");
  console.log(`- First turn cached tokens: ${firstTurnResult.cachedTokens}`);
  console.log(`- Second turn cached tokens: ${secondTurnResult.cachedTokens}`);
  console.log(
    "- This probe isolates provider-native continuation via StateAccessor rather than transcript persistence.",
  );
  console.log(
    "- If second-turn cached tokens remain zero, that suggests either no visible prompt-cache read or that provider-native continuation does not surface as prompt-cache reuse in usage metrics.",
  );

  console.log("\n✅ StateAccessor continuity cache probe completed.");
}
