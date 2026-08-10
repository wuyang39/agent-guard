import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  MainAgentSupervisionServiceError,
  type MainAgentSupervisionService,
  type MainAgentSupervisionStatus,
} from "../../../modules/openclaw/mainAgentSupervisionService";
import { failure, success } from "../../response";

const BASE_PATH = "/api/v1/openclaw/native-supervision";

const START_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["policyPackId"],
  properties: {
    policyPackId: { type: "string", minLength: 1, maxLength: 256 },
  },
} as const;

const STOP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  maxProperties: 0,
} as const;

export type NativeSupervisionRouteOptions = {
  service: MainAgentSupervisionService;
};

export async function openClawNativeSupervisionRoutes(
  app: FastifyInstance,
  options: NativeSupervisionRouteOptions,
): Promise<void> {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof MainAgentSupervisionServiceError) {
      reply.code(error.statusCode);
      return failure(error.code, error.message);
    }
    const fastifyError = error as { code?: string; validation?: unknown };
    if (
      fastifyError.validation !== undefined ||
      fastifyError.code === "FST_ERR_CTP_INVALID_JSON_BODY"
    ) {
      reply.code(400);
      return failure(
        "MAIN_AGENT_SUPERVISION_INVALID_REQUEST",
        "Main-agent supervision request payload is invalid.",
      );
    }
    reply.code(503);
    return failure(
      "MAIN_AGENT_SUPERVISION_UNAVAILABLE",
      "Main-agent supervision is unavailable.",
    );
  });

  app.get(BASE_PATH, async () => success(sanitizeStatus(
    await options.service.status(),
  )));

  app.post(`${BASE_PATH}/start`, {
    schema: { body: START_SCHEMA },
    preValidation: rejectNonExactStartBody,
  }, async (request) => {
    const { policyPackId } = request.body as { policyPackId: string };
    return success(sanitizeStatus(await options.service.start(policyPackId)));
  });

  app.post(`${BASE_PATH}/stop`, {
    schema: {},
    preValidation: rejectNonEmptyStopBody,
  }, async () => success(sanitizeStatus(await options.service.stop())));
}

async function rejectNonExactStartBody(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const body = request.body;
  if (
    !isRecord(body) ||
    Object.keys(body).length !== 1 ||
    typeof body.policyPackId !== "string" ||
    body.policyPackId.length < START_SCHEMA.properties.policyPackId.minLength ||
    body.policyPackId.length > START_SCHEMA.properties.policyPackId.maxLength
  ) {
    reply.code(400).send(invalidRequest());
  }
}

async function rejectNonEmptyStopBody(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (
    request.body !== undefined &&
    (!isRecord(request.body) || Object.keys(request.body).length > STOP_SCHEMA.maxProperties)
  ) {
    reply.code(400).send(invalidRequest());
  }
}

function invalidRequest() {
  return failure(
    "MAIN_AGENT_SUPERVISION_INVALID_REQUEST",
    "Main-agent supervision request payload is invalid.",
  );
}

function sanitizeStatus(status: MainAgentSupervisionStatus): MainAgentSupervisionStatus {
  return {
    coverage: status.coverage,
    scope: { kind: "agent", agentId: "main" },
    ...(status.policyPackId === undefined ? {} : { policyPackId: status.policyPackId }),
    ...(status.leaseId === undefined ? {} : { leaseId: status.leaseId }),
    ...(status.leaseEpoch === undefined ? {} : { leaseEpoch: status.leaseEpoch }),
    ...(status.expiresAt === undefined ? {} : { expiresAt: status.expiresAt }),
    ...(status.gatewayInstanceId === undefined
      ? {}
      : { gatewayInstanceId: status.gatewayInstanceId }),
    activeLeaseCount: status.activeLeaseCount,
    mainLeaseCount: status.mainLeaseCount,
    ...(status.reasonCode === undefined ? {} : { reasonCode: status.reasonCode }),
    ...(status.detail === undefined ? {} : { detail: status.detail }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
