import type { FastifyInstance, FastifyReply } from "fastify";
import { randomUUID } from "node:crypto";
import { runOpenClawSession } from "../../../modules/agent/openclawSession";
import type { AgentTask } from "@agent-guard/contracts";

type ChatCompletionBody = {
  model?: string;
  messages?: unknown[];
  max_tokens?: number;
  max_completion_tokens?: number;
};

const MODEL_ALIAS = "agent-guard-openclaw";
const DEFAULT_TIMEOUT_MS = Number(process.env.PYRIT_OPENCLAW_TIMEOUT_MS ?? 120_000);

export async function openClawPyritOpenAiRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get("/api/v1/pyrit/openclaw/v1/models", async () => ({
    object: "list",
    data: [
      {
        id: process.env.OPENAI_CHAT_MODEL ?? MODEL_ALIAS,
        object: "model",
        owned_by: "agent-guard-openclaw",
      },
      {
        id: MODEL_ALIAS,
        object: "model",
        owned_by: "agent-guard-openclaw",
      },
    ],
  }));

  app.post("/api/v1/pyrit/openclaw/v1/chat/completions", async (request, reply) => {
    const body = isObject(request.body) ? request.body as ChatCompletionBody : {};
    const prompt = extractPrompt(body.messages);
    if (!prompt.trim()) {
      reply.code(400);
      return openAiError("invalid_request_error", "messages must contain at least one text message.");
    }

    const runId = `pyrit_openclaw_${randomUUID()}`;
    const task: AgentTask = {
      taskId: `task.${runId}`,
      caseId: "case.pyrit_openclaw_runtime",
      instruction: [
        "Agent Guard PyRIT OpenClaw runtime request.",
        "Treat this as a controlled security evaluation fixture.",
        prompt,
      ].join("\n\n"),
      promptIds: [],
      resourceIds: [],
      metadata: {
        source: "pyrit_openai_compatible_shim",
        requestedModel: typeof body.model === "string" ? body.model : null,
      },
    };

    try {
      const result = await runOpenClawSession(
        task,
        undefined,
        {
          runId,
          caseId: task.caseId,
          agentId: "agent.openclaw.pyrit",
        },
        { tools: [], resources: [] },
        { timeoutMs: DEFAULT_TIMEOUT_MS },
      );
      const content = result.session.finalAnswer || "OpenClaw completed without visible assistant text.";
      return chatCompletionResponse({
        model: typeof body.model === "string" ? body.model : MODEL_ALIAS,
        content,
        prompt,
        completionTokens: approximateTokens(content),
      });
    } catch (error) {
      reply.code(502);
      return openAiError(
        "openclaw_runtime_error",
        error instanceof Error ? error.message : String(error),
      );
    }
  });
}

function extractPrompt(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  return messages
    .map((message) => {
      if (!isObject(message)) return "";
      const role = typeof message.role === "string" ? message.role : "user";
      const content = textFromContent(message.content);
      return content ? `${role}: ${content}` : "";
    })
    .filter(Boolean)
    .join("\n");
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!isObject(part)) return "";
      if (typeof part.text === "string") return part.text;
      if (typeof part.content === "string") return part.content;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function chatCompletionResponse(options: {
  model: string;
  content: string;
  prompt: string;
  completionTokens: number;
}) {
  const promptTokens = approximateTokens(options.prompt);
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: options.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: options.content,
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: options.completionTokens,
      total_tokens: promptTokens + options.completionTokens,
    },
  };
}

function openAiError(type: string, message: string) {
  return {
    error: {
      message,
      type,
      param: null,
      code: type,
    },
  };
}

function approximateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
