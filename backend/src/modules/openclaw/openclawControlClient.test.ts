import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import type { NativeGuardLeaseActivation, NativeGuardStatus } from "@agent-guard/contracts";
import { signNativeGuardPayload } from "@agent-guard/native-guard-protocol";
import {
  OpenClawControlClientError,
  createOpenClawControlClient,
  type OpenClawCommandRunner,
} from "./openclawControlClient";

const TOKEN = "gateway-token-that-must-stay-secret";
const TEST_ATTESTATION_KEYS = generateKeyPairSync("ed25519");

test("rejects non-loopback and ambiguous gateway URLs before making a request", async () => {
  let calls = 0;
  const client = createOpenClawControlClient({
    gatewayToken: TOKEN,
    fetch: async () => {
      calls += 1;
      return jsonResponse(readyStatus());
    },
  });

  for (const url of [
    "https://example.com",
    "ftp://127.0.0.1",
    "http://user:pass@localhost",
    "http://localhost?next=evil",
    "http://127.0.0.1/#fragment",
    "http://127.0.0.2",
    "http://2130706433",
    "http://127.1",
  ]) {
    await assert.rejects(() => client.status(url), hasCode("OPENCLAW_CONTROL_INVALID_GATEWAY"));
  }
  assert.equal(calls, 0);
});

test("converts ws loopback URLs, fixes the status route, and sends bearer auth without redirects", async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  const client = createOpenClawControlClient({
    gatewayToken: TOKEN,
    fetch: async (input, init) => {
      request = { url: String(input), init };
      return jsonResponse({ ...readyStatus(), ignoredPluginField: TOKEN });
    },
  });

  const status = await client.status("ws://127.0.0.1:18789/untrusted/base");

  assert.equal(request?.url, "http://127.0.0.1:18789/agent-guard/native-guard/v1/status");
  assert.equal(new Headers(request?.init?.headers).get("authorization"), `Bearer ${TOKEN}`);
  assert.equal(new Headers(request?.init?.headers).get("cache-control"), "no-store");
  assert.equal(request?.init?.redirect, "error");
  assert.equal(request?.init?.method, "GET");
  assert.deepEqual(status, readyStatus());
  assert.equal(request?.url.includes(TOKEN), false);
});

test("uses fixed POST routes and stable operation-bound idempotency keys", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const client = createOpenClawControlClient({
    env: { OPENCLAW_GATEWAY_TOKEN: TOKEN },
    fetch: async (input, init) => {
      requests.push({ url: String(input), init });
      return jsonResponse(activeStatus(ACTIVATION));
    },
  });

  await client.activate("wss://[::1]:18789/base", ACTIVATION);
  await client.activate("wss://[::1]:18789/base", ACTIVATION);
  await client.renew("https://localhost:18789/base", ACTIVATION);

  assert.deepEqual(
    requests.map((entry) => new URL(entry.url).pathname),
    [
      "/agent-guard/native-guard/v1/leases/activate",
      "/agent-guard/native-guard/v1/leases/activate",
      "/agent-guard/native-guard/v1/leases/renew",
    ],
  );
  const keys = requests.map((entry) => new Headers(entry.init?.headers).get("x-idempotency-key"));
  assert.equal(keys[0], keys[1]);
  assert.notEqual(keys[0], keys[2]);
  assert.equal(new Headers(requests[0].init?.headers).get("content-type"), "application/json");
  assert.deepEqual(JSON.parse(String(requests[0].init?.body)), ACTIVATION);
});

test("requires and projects the complete credential-free active lease acknowledgement", async () => {
  const complete = activeStatus(ACTIVATION);
  const projectedClient = createOpenClawControlClient({
    gatewayToken: TOKEN,
    fetch: async () => jsonResponse({ ...complete, ignored: "plugin-body" }),
  });
  const projected = await projectedClient.status("http://localhost");
  assert.equal(projected.activeLease?.leaseEpoch, ACTIVATION.leaseEpoch);
  assert.equal(projected.activeLease?.policyPackDigest, ACTIVATION.policyPackDigest);
  assert.equal("credential" in (projected.activeLease ?? {}), false);

  for (const field of ["leaseEpoch", "policyPackDigest"] as const) {
    const invalid = structuredClone(complete) as NativeGuardStatus;
    delete (invalid.activeLease as unknown as Record<string, unknown>)[field];
    const client = createOpenClawControlClient({
      gatewayToken: TOKEN,
      fetch: async () => jsonResponse(invalid),
    });
    await assert.rejects(
      () => client.status("http://localhost"),
      hasCode("OPENCLAW_CONTROL_INVALID_RESPONSE"),
    );
  }
});

test("rejects oversized response bodies from content-length and streaming readers", async () => {
  const byLength = createOpenClawControlClient({
    gatewayToken: TOKEN,
    fetch: async () => new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json", "content-length": "65537" },
    }),
  });
  await assert.rejects(() => byLength.status("http://localhost"), hasCode("OPENCLAW_CONTROL_RESPONSE_TOO_LARGE"));

  const bytes = new TextEncoder().encode("x".repeat(65_537));
  const byStream = createOpenClawControlClient({
    gatewayToken: TOKEN,
    fetch: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 40_000));
        controller.enqueue(bytes.subarray(40_000));
        controller.close();
      },
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  await assert.rejects(() => byStream.status("http://localhost"), hasCode("OPENCLAW_CONTROL_RESPONSE_TOO_LARGE"));
});

test("cancels rejected HTTP, declared-oversize, and invalid-content response bodies", async () => {
  for (const response of [
    cancellableResponse({ status: 500, contentType: "application/json" }),
    cancellableResponse({
      status: 200,
      contentType: "application/json",
      contentLength: "65537",
    }),
    cancellableResponse({ status: 200, contentType: "text/plain" }),
  ]) {
    const client = createOpenClawControlClient({
      gatewayToken: TOKEN,
      fetch: async () => response.value,
    });
    await assert.rejects(() => client.status("http://localhost"));
    assert.equal(response.cancelled(), 1);
  }
});

test("times out requests and redacts tokens from transport failures", async () => {
  const timed = createOpenClawControlClient({
    gatewayToken: TOKEN,
    timeoutMs: 5,
    fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
  });
  await assert.rejects(() => timed.status("http://localhost"), hasCode("OPENCLAW_CONTROL_TIMEOUT"));

  const failed = createOpenClawControlClient({
    gatewayToken: TOKEN,
    fetch: async () => { throw new Error(`transport exposed ${TOKEN}`); },
  });
  await assert.rejects(
    () => failed.status("http://localhost"),
    (error: unknown) => error instanceof Error && !error.message.includes(TOKEN) &&
      (error as OpenClawControlClientError).code === "OPENCLAW_CONTROL_UNAVAILABLE",
  );

  const spoofed = createOpenClawControlClient({
    gatewayToken: TOKEN,
    fetch: async () => {
      throw new OpenClawControlClientError("CUSTOM_TRANSPORT", `spoofed ${TOKEN}`);
    },
  });
  await assert.rejects(
    () => spoofed.status("http://localhost"),
    (error: unknown) => error instanceof Error && !error.message.includes(TOKEN),
  );
});

test("times out a stalled response stream", async () => {
  const client = createOpenClawControlClient({
    gatewayToken: TOKEN,
    timeoutMs: 5,
    fetch: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
      },
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });

  await assert.rejects(
    () => client.status("http://localhost"),
    hasCode("OPENCLAW_CONTROL_TIMEOUT"),
  );
});

test("keeps capability CLI and HTTP control timeout budgets independent", async () => {
  const cliTimeouts: number[] = [];
  const client = createOpenClawControlClient({
    gatewayToken: TOKEN,
    timeoutMs: 5,
    capabilityTimeoutMs: 30_000,
    commandRunner: async (input) => {
      cliTimeouts.push(input.timeoutMs);
      return cliTimeouts.length === 1
        ? result("2026.7.2")
        : result(JSON.stringify([agentGuardPlugin()]));
    },
    fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
  });

  await client.inspectCapabilities({ isolatedProfile: true });
  assert.deepEqual(cliTimeouts, [30_000, 30_000]);
  await assert.rejects(
    () => client.status("http://localhost"),
    hasCode("OPENCLAW_CONTROL_TIMEOUT"),
  );
});

test("does not accept a new version without the enabled Trusted Tool Policy contract", async () => {
  const runner = commandRunner([
    result("OpenClaw 2026.7.2\n"),
    result(JSON.stringify([{ id: "agent-guard-supervision", enabled: true, hookNames: ["before_tool_call"] }])),
  ]);
  const client = createOpenClawControlClient({ gatewayToken: TOKEN, commandRunner: runner });

  const capability = await client.inspectCapabilities({ cliPath: "openclaw", isolatedProfile: false });

  assert.equal(capability.openclawVersion, "2026.7.2");
  assert.equal(capability.supportsNativeGuard, false);
  assert.equal(capability.finalizerAssurance, "unverified");
});

test("accepts the exact Agent Guard admission contract from a nested plugin manifest", async () => {
  const plugin = {
    id: "agent-guard-supervision",
    enabled: true,
    hookNames: ["before_tool_call"],
    manifest: { contracts: { trustedToolPolicies: ["agent-guard-admission"] } },
  };
  const client = createOpenClawControlClient({
    gatewayToken: TOKEN,
    commandRunner: commandRunner([
      result("2026.7.2"),
      result(JSON.stringify(liveInventory([plugin]))),
    ]),
  });

  const capability = await client.inspectCapabilities({ isolatedProfile: false });

  assert.equal(capability.supportsNativeGuard, true);
  assert.equal(capability.finalizerAssurance, "exclusive_before_hook");
});

test("requires complete live registry proof outside an isolated profile", async () => {
  const client = createOpenClawControlClient({
    gatewayToken: TOKEN,
    commandRunner: commandRunner([
      result("2026.7.2"),
      result(JSON.stringify({
        plugins: [agentGuardPlugin()],
        diagnostics: [],
        registry: { diagnostics: [] },
      })),
    ]),
  });

  assert.deepEqual(await client.inspectCapabilities({ isolatedProfile: false }), {
    openclawVersion: "2026.7.2",
    supportsNativeGuard: false,
    finalizerAssurance: "unverified",
    conflictingPluginIds: [],
  });
});

test("propagates the authoritative Gateway identity from a valid live plugin inventory", async () => {
  const client = createOpenClawControlClient({
    gatewayToken: TOKEN,
    commandRunner: commandRunner([
      result("2026.7.2"),
      result(JSON.stringify(liveInventory(
        [agentGuardPlugin()],
        "gateway.instance.live.1",
      ))),
    ]),
  });

  const capability = await client.inspectCapabilities({ isolatedProfile: false });

  assert.equal(capability.supportsNativeGuard, true);
  assert.equal(capability.gatewayInstanceId, "gateway.instance.live.1");
});

test("accepts the host live contribution for a dedicated isolated profile", async () => {
  const plugin = {
    id: "agent-guard-supervision",
    enabled: true,
    status: "loaded",
    activated: true,
    hookNames: ["after_tool_call", "before_tool_call"],
    services: ["agent-guard-runtime"],
    trustedToolPolicies: ["agent-guard-admission"],
  };
  const client = createOpenClawControlClient({
    gatewayToken: TOKEN,
    commandRunner: commandRunner([
      result("2026.7.1-agentguard.1"),
      result(JSON.stringify(liveInventory([plugin]))),
    ]),
  });

  assert.deepEqual(await client.inspectCapabilities({
    isolatedProfile: true,
    liveRegistry: true,
  }), {
    openclawVersion: "2026.7.1-agentguard.1",
    supportsNativeGuard: true,
    finalizerAssurance: "exclusive_before_hook",
    conflictingPluginIds: [],
  });
});

test("accepts a healthy isolated cold plugin inventory without runtime registry attestation", async () => {
  const client = createOpenClawControlClient({
    gatewayToken: TOKEN,
    commandRunner: commandRunner([
      result("2026.7.1-agentguard.1"),
      result(JSON.stringify({ plugins: [coldForkAgentGuardPlugin()], diagnostics: [] })),
    ]),
  });

  assert.deepEqual(await client.inspectCapabilities({ isolatedProfile: true }), {
    openclawVersion: "2026.7.1-agentguard.1",
    supportsNativeGuard: true,
    finalizerAssurance: "isolated_profile",
    conflictingPluginIds: [],
  });
});

test("accepts the real cold inventory shape with an informational registry diagnostic", async () => {
  const client = createOpenClawControlClient({
    gatewayToken: TOKEN,
    commandRunner: commandRunner([
      result("2026.7.1-agentguard.1"),
      result(JSON.stringify({
        workspaceDir: "C:\\openclaw\\workspace",
        registry: {
          source: "derived",
          diagnostics: [{
            level: "info",
            code: "persisted-registry-missing",
            message: "Persisted plugin registry is missing or invalid; using derived plugin index.",
          }],
        },
        plugins: [coldForkAgentGuardPlugin()],
        diagnostics: [],
      })),
    ]),
  });

  assert.deepEqual(await client.inspectCapabilities({ isolatedProfile: true }), {
    openclawVersion: "2026.7.1-agentguard.1",
    supportsNativeGuard: true,
    finalizerAssurance: "isolated_profile",
    conflictingPluginIds: [],
  });
});

test("ignores a spoofed cold registry marker and relies on the static plugin contract", async () => {
  const client = createOpenClawControlClient({
    gatewayToken: TOKEN,
    commandRunner: commandRunner([
      result("2026.7.1-agentguard.1"),
      result(JSON.stringify({
        plugins: [agentGuardPlugin()],
        registry: { liveAttestation: true },
      })),
    ]),
  });

  const capability = await client.inspectCapabilities({ isolatedProfile: true });

  assert.equal(capability.supportsNativeGuard, true);
  assert.equal(capability.finalizerAssurance, "isolated_profile");
});

test("accepts a compatible fork with the complete static plugin contract", async () => {
  const client = createOpenClawControlClient({
    gatewayToken: TOKEN,
    commandRunner: commandRunner([
      result("2026.7.1-agentguard.1"),
      result(JSON.stringify(liveInventory([agentGuardPlugin()]))),
    ]),
  });

  const capability = await client.inspectCapabilities({ isolatedProfile: true });

  assert.equal(capability.supportsNativeGuard, true);
  assert.equal(capability.finalizerAssurance, "isolated_profile");
});

test("binds live Gateway identity through the direct authenticated core HTTP route", async () => {
  const challenge = "A".repeat(32);
  const gatewayUrl = "http://127.0.0.1:18789";
  let request: { url: string; init?: RequestInit } | undefined;
  const client = createOpenClawControlClient({
    gatewayToken: TOKEN,
    fetch: async (input, init) => {
      request = { url: String(input), init };
      return jsonResponse(gatewayAttestation(gatewayUrl, challenge));
    },
    commandRunner: async () => { throw new Error("CLI must not run for Gateway attestation"); },
  });

  const attestation = await client.attestGateway({
    gatewayUrl,
    challenge,
    attestationPublicKey: TEST_ATTESTATION_KEYS.publicKey,
  });

  assert.equal(attestation.gatewayInstanceId, "gateway.instance.1");
  assert.equal(
    request?.url,
    `${gatewayUrl}/agent-guard/native-guard/v1/gateway-attestation`,
  );
  assert.equal(request?.init?.method, "POST");
  assert.equal(request?.init?.redirect, "error");
  assert.equal(new Headers(request?.init?.headers).get("authorization"), `Bearer ${TOKEN}`);
  assert.equal(new Headers(request?.init?.headers).get("content-type"), "application/json");
  assert.deepEqual(JSON.parse(String(request?.init?.body)), { challenge });
});

test("Gateway attestation rejects transport and exact-schema failures", async (t) => {
  const challenge = "A".repeat(32);
  const gatewayUrl = "http://127.0.0.1:18789";
  const cases: Array<{
    name: string;
    token?: string;
    response: () => Response;
    code: string;
  }> = [
    {
      name: "redirect",
      response: () => new Response("", {
        status: 302,
        headers: { location: "http://127.0.0.1:19999/elsewhere" },
      }),
      code: "OPENCLAW_CONTROL_HTTP_ERROR",
    },
    {
      name: "wrong auth",
      token: "wrong-gateway-token",
      response: () => jsonResponse({ error: "unauthorized" }, 401),
      code: "OPENCLAW_CONTROL_HTTP_ERROR",
    },
    {
      name: "oversize",
      response: () => new Response("{}", {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-length": "65537",
        },
      }),
      code: "OPENCLAW_CONTROL_RESPONSE_TOO_LARGE",
    },
    {
      name: "malformed JSON",
      response: () => new Response("{", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      code: "OPENCLAW_CONTROL_INVALID_RESPONSE",
    },
    {
      name: "extra schema key",
      response: () => jsonResponse({
        ...gatewayAttestation(gatewayUrl, challenge),
        extra: true,
      }),
      code: "OPENCLAW_CONTROL_INVALID_RESPONSE",
    },
    {
      name: "challenge mismatch",
      response: () => jsonResponse(gatewayAttestation(gatewayUrl, "B".repeat(32))),
      code: "OPENCLAW_CONTROL_INVALID_RESPONSE",
    },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const client = createOpenClawControlClient({
        gatewayToken: entry.token ?? TOKEN,
        fetch: async (_input, init) => {
          if (entry.name === "wrong auth") {
            assert.equal(
              new Headers(init?.headers).get("authorization"),
              "Bearer wrong-gateway-token",
            );
          }
          return entry.response();
        },
        commandRunner: async () => { throw new Error("CLI must not run"); },
      });
      await assert.rejects(
        () => client.attestGateway({
          gatewayUrl,
          challenge,
          attestationPublicKey: TEST_ATTESTATION_KEYS.publicKey,
        }),
        hasCode(entry.code),
      );
    });
  }
});

test("rejects application/jsonp as a control response media type", async () => {
  const client = createOpenClawControlClient({
    gatewayToken: TOKEN,
    fetch: async () => new Response(JSON.stringify(readyStatus()), {
      status: 200,
      headers: { "content-type": "application/jsonp; charset=utf-8" },
    }),
  });
  await assert.rejects(
    () => client.status("http://localhost"),
    hasCode("OPENCLAW_CONTROL_INVALID_RESPONSE"),
  );
});

test("Gateway attestation bounds cancellation without replacing the original rejection", async (t) => {
  const challenge = "A".repeat(32);
  const gatewayUrl = "http://127.0.0.1:18789";
  const cases: Array<{
    name: string;
    status: number;
    headers: Record<string, string>;
    body?: Uint8Array;
    code: string;
  }> = [
    {
      name: "non-2xx",
      status: 500,
      headers: { "content-type": "application/json" },
      code: "OPENCLAW_CONTROL_HTTP_ERROR",
    },
    {
      name: "declared oversize",
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-length": "65537",
      },
      code: "OPENCLAW_CONTROL_RESPONSE_TOO_LARGE",
    },
    {
      name: "streaming oversize",
      status: 200,
      headers: { "content-type": "application/json" },
      body: new Uint8Array(65537),
      code: "OPENCLAW_CONTROL_RESPONSE_TOO_LARGE",
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const response = neverSettlingCancelResponse({
        status: entry.status,
        headers: entry.headers,
        body: entry.body,
      });
      const client = createOpenClawControlClient({
        gatewayToken: TOKEN,
        timeoutMs: 5,
        fetch: async () => response.value,
      });

      await assert.rejects(
        () => settleWithin(
          client.attestGateway({
            gatewayUrl,
            challenge,
            attestationPublicKey: TEST_ATTESTATION_KEYS.publicKey,
          }),
          250,
        ),
        hasCode(entry.code),
      );
      assert.equal(response.cancelled(), 1);
    });
  }
});

test("Gateway attestation rejects every Content-Encoding before reading the body", async (t) => {
  const challenge = "A".repeat(32);
  const gatewayUrl = "http://127.0.0.1:18789";

  for (const encoding of ["gzip", "identity"]) {
    await t.test(encoding, async () => {
      let cancelCount = 0;
      let readerCount = 0;
      const response = {
        ok: true,
        status: 200,
        headers: new Headers({
          "content-type": "application/json",
          "content-encoding": encoding,
        }),
        body: {
          async cancel() {
            cancelCount += 1;
          },
          getReader() {
            readerCount += 1;
            throw new Error("Encoded response body must not be read.");
          },
        },
      } as unknown as Response;
      const client = createOpenClawControlClient({
        gatewayToken: TOKEN,
        fetch: async () => response,
      });

      await assert.rejects(
        () => client.attestGateway({
          gatewayUrl,
          challenge,
          attestationPublicKey: TEST_ATTESTATION_KEYS.publicKey,
        }),
        hasCode("OPENCLAW_CONTROL_INVALID_RESPONSE"),
      );
      assert.equal(cancelCount, 1);
      assert.equal(readerCount, 0);
    });
  }
});

test("fails closed on Agent Guard error status and equivalent failure metadata", async (t) => {
  for (const failure of [
    { status: "error" },
    { status: "disabled" },
    { status: "loaded", error: "registration failed" },
    { status: "loaded", failurePhase: "register" },
  ]) {
    await t.test(JSON.stringify(failure), async () => {
      const capability = await inspectInventory({
        plugins: [{ ...agentGuardPlugin(), ...failure }],
        diagnostics: [],
        registry: { diagnostics: [] },
      });

      assert.equal(capability.supportsNativeGuard, false);
      assert.equal(capability.finalizerAssurance, "unverified");
    });
  }
});

test("fails closed on Agent Guard contribution errors from either diagnostic surface", async (t) => {
  const cases: Array<{
    location: "top" | "registry";
    message: string;
    pluginId?: string;
  }> = [
    {
      location: "top",
      message: "plugin registration failed",
      pluginId: "agent-guard-supervision",
    },
    {
      location: "registry",
      message: "http route already registered: /agent-guard/native-guard/v1/status (exact) by existing-plugin (C:\\plugins\\existing-plugin)",
    },
    {
      location: "top",
      message: "service already registered: agent-guard-runtime (existing-plugin)",
    },
    {
      location: "registry",
      message: "trusted tool policy already registered: agent-guard-admission (existing-plugin)",
    },
    {
      location: "top",
      message: "hook already registered: before_tool_call (agent-guard-supervision)",
    },
  ];

  for (const entry of cases) {
    await t.test(entry.message, async () => {
      const diagnostic = {
        level: "error",
        message: entry.message,
        ...(entry.pluginId === undefined ? {} : { pluginId: entry.pluginId }),
      };
      const capability = await inspectInventory({
        plugins: [agentGuardPlugin()],
        diagnostics: entry.location === "top" ? [diagnostic] : [],
        registry: { diagnostics: entry.location === "registry" ? [diagnostic] : [] },
      });

      assert.equal(capability.supportsNativeGuard, false);
      assert.equal(capability.finalizerAssurance, "unverified");
    });
  }
});

test("does not treat warnings or unrelated plugin errors as Agent Guard failures", async () => {
  const capability = await inspectInventory({
    plugins: [agentGuardPlugin()],
    diagnostics: [
      {
        level: "warn",
        pluginId: "agent-guard-supervision",
        message: "manifest used a deprecated field",
      },
      {
        level: "error",
        pluginId: "unrelated-plugin",
        message: "unrelated provider registration failed",
      },
    ],
    registry: { diagnostics: [] },
  });

  assert.equal(capability.supportsNativeGuard, true);
  assert.equal(capability.finalizerAssurance, "exclusive_before_hook");
});

test("structured diagnostic ownership overrides embedded Agent Guard text", async (t) => {
  for (const message of [
    "agent-guard-supervision",
    "http route already registered: /agent-guard/native-guard/v1/status (exact) by existing-plugin (C:\\plugins\\existing-plugin)",
    "service already registered: agent-guard-runtime (existing-plugin)",
    "trusted tool policy already registered: agent-guard-admission (existing-plugin)",
    "hook already registered: before_tool_call (agent-guard-supervision)",
  ]) {
    await t.test(message, async () => {
      const capability = await inspectInventory({
        plugins: [agentGuardPlugin()],
        diagnostics: [{ level: "error", pluginId: "unrelated-plugin", message }],
        registry: { diagnostics: [] },
      });

      assert.equal(capability.supportsNativeGuard, true);
      assert.equal(capability.finalizerAssurance, "exclusive_before_hook");
    });
  }
});

test("ownerless legacy diagnostics accept every exact guarded conflict template", async (t) => {
  const routePaths = [
    "/agent-guard/native-guard/v1/leases/activate",
    "/agent-guard/native-guard/v1/leases/renew",
    "/agent-guard/native-guard/v1/leases/revoke",
    "/agent-guard/native-guard/v1/status",
  ];
  const messages = [
    ...routePaths.map((route) =>
      `http route already registered: ${route} (exact) by existing-plugin (C:\\plugins\\existing-plugin)`),
    "service already registered: agent-guard-runtime (existing-plugin)",
    "trusted tool policy already registered: agent-guard-admission (existing-plugin)",
    "hook already registered: before_tool_call (agent-guard-supervision)",
    "SeRvIcE AlReAdY ReGiStErEd: agent-guard-runtime (existing-plugin)",
  ];

  for (const message of messages) {
    await t.test(message, async () => {
      const capability = await inspectInventory({
        plugins: [agentGuardPlugin()],
        diagnostics: [{ level: "error", message }],
        registry: { diagnostics: [] },
      });

      assert.equal(capability.supportsNativeGuard, false);
      assert.equal(capability.finalizerAssurance, "unverified");
    });
  }
});

test("ownerless legacy diagnostic fallback rejects wrapped and lookalike templates", async (t) => {
  for (const message of [
    "prefix service already registered: agent-guard-runtime (existing-plugin)",
    "service already registered: agent-guard-runtime (existing-plugin) suffix",
    "unrelated error quotes 'service already registered: agent-guard-runtime (existing-plugin)'",
    "service already registered: agent-guard-runtime-extra (existing-plugin)",
    "service already registered: Agent-Guard-Runtime (existing-plugin)",
    "service already registered: agent\u2010guard-runtime (existing-plugin)",
    "trusted tool policy already registered: agent-guard-admission-extra (existing-plugin)",
    "hook already registered: before_tool_call_extra (agent-guard-supervision)",
    "hook already registered: before_tool_call (agent-guard-supervision-extra)",
    "http route already registered: /agent-guard/native-guard/v1/status/extra (exact) by existing-plugin (C:\\plugins\\existing-plugin)",
    "http route already registered: /Agent-guard/native-guard/v1/status (exact) by existing-plugin (C:\\plugins\\existing-plugin)",
    "prefix http route already registered: /agent-guard/native-guard/v1/status (exact) by existing-plugin (C:\\plugins\\existing-plugin)",
  ]) {
    await t.test(message, async () => {
      const capability = await inspectInventory({
        plugins: [agentGuardPlugin()],
        diagnostics: [],
        registry: { diagnostics: [{ level: "error", message }] },
      });

      assert.equal(capability.supportsNativeGuard, true);
      assert.equal(capability.finalizerAssurance, "exclusive_before_hook");
    });
  }
});

test("rejects malformed top-level and registry diagnostics", async () => {
  for (const inventory of [
    { plugins: [agentGuardPlugin()], diagnostics: {} },
    { plugins: [agentGuardPlugin()], registry: [] },
    { plugins: [agentGuardPlugin()], registry: { diagnostics: "invalid" } },
    {
      plugins: [agentGuardPlugin()],
      diagnostics: [{ level: "fatal", message: "invalid level" }],
    },
    {
      plugins: [agentGuardPlugin()],
      diagnostics: [{ level: "error", pluginId: "agent-guard-supervision" }],
    },
    {
      plugins: [agentGuardPlugin()],
      diagnostics: [{ level: "error", message: "invalid owner", pluginId: 1 }],
    },
  ]) {
    await assert.rejects(
      () => inspectInventory(inventory),
      hasCode("OPENCLAW_CLI_INVALID_OUTPUT"),
    );
  }
});

test("rejects an oversized diagnostic payload before capability inspection", async () => {
  const inventory = JSON.stringify({
    plugins: [agentGuardPlugin()],
    diagnostics: [{
      level: "error",
      pluginId: "agent-guard-supervision",
      message: "x".repeat(65_536),
    }],
  });
  const client = createOpenClawControlClient({
    gatewayToken: TOKEN,
    commandRunner: commandRunner([result("2026.7.2"), result(inventory)]),
  });

  await assert.rejects(
    () => client.inspectCapabilities({ isolatedProfile: false }),
    hasCode("OPENCLAW_CLI_OUTPUT_TOO_LARGE"),
  );
});

test("rejects non-exact Trusted Tool Policy contract declarations", async () => {
  const invalidPlugins = [
    {
      id: "agent-guard-supervision",
      enabled: true,
      hookNames: ["before_tool_call"],
      contracts: { trustedToolPolicies: ["agent-guard-admission", "extra-policy"] },
    },
    {
      id: "agent-guard-supervision",
      enabled: true,
      hookNames: ["before_tool_call"],
      contracts: { trustedToolPolicies: true },
    },
    {
      id: "agent-guard-supervision",
      enabled: true,
      hookNames: ["before_tool_call"],
      trustedToolPolicyContract: "native-guard-1",
    },
    {
      id: "agent-guard-supervision",
      enabled: true,
      hookNames: ["before_tool_call"],
      capabilities: { trustedToolPolicy: { contract: "native-guard-1" } },
    },
  ];

  for (const plugin of invalidPlugins) {
    const client = createOpenClawControlClient({
      gatewayToken: TOKEN,
      commandRunner: commandRunner([result("2026.7.2"), result(JSON.stringify([plugin]))]),
    });
    const capability = await client.inspectCapabilities({ isolatedProfile: false });
    assert.equal(capability.supportsNativeGuard, false);
    assert.equal(capability.finalizerAssurance, "unverified");
  }
});

test("requires the exact before_tool_call string in hookNames", async () => {
  const plugin = {
    id: "agent-guard-supervision",
    enabled: true,
    hookNames: [{ name: "before_tool_call" }],
    contracts: { trustedToolPolicies: ["agent-guard-admission"] },
  };
  const client = createOpenClawControlClient({
    gatewayToken: TOKEN,
    commandRunner: commandRunner([result("2026.7.2"), result(JSON.stringify([plugin]))]),
  });

  const capability = await client.inspectCapabilities({ isolatedProfile: false });

  assert.equal(capability.supportsNativeGuard, false);
  assert.equal(capability.finalizerAssurance, "unverified");
});

test("rejects hooks alias-only Agent Guard declarations and ignores alias-only conflicts", async () => {
  const aliasOnlyAgent = {
    id: "agent-guard-supervision",
    enabled: true,
    hooks: ["before_tool_call"],
    contracts: { trustedToolPolicies: ["agent-guard-admission"] },
  };
  const unsupported = createOpenClawControlClient({
    gatewayToken: TOKEN,
    commandRunner: commandRunner([
      result("2026.7.2"),
      result(JSON.stringify([aliasOnlyAgent])),
    ]),
  });
  assert.deepEqual(await unsupported.inspectCapabilities({ isolatedProfile: false }), {
    openclawVersion: "2026.7.2",
    supportsNativeGuard: false,
    finalizerAssurance: "unverified",
    conflictingPluginIds: [],
  });

  const aliasConflict = createOpenClawControlClient({
    gatewayToken: TOKEN,
    commandRunner: commandRunner([
      result("2026.7.2"),
      result(JSON.stringify(liveInventory([
        agentGuardPlugin(),
        { id: "alias-only-other", enabled: true, hooks: ["before_tool_call"] },
      ]))),
    ]),
  });
  assert.deepEqual(await aliasConflict.inspectCapabilities({ isolatedProfile: false }), {
    openclawVersion: "2026.7.2",
    supportsNativeGuard: true,
    finalizerAssurance: "exclusive_before_hook",
    conflictingPluginIds: [],
  });
});

test("rejects mixed Trusted Tool Policy declarations when any present location is invalid", async () => {
  const exact = { trustedToolPolicies: ["agent-guard-admission"] };
  const extra = { trustedToolPolicies: ["agent-guard-admission", "extra-policy"] };
  const plugins = [
    {
      id: "agent-guard-supervision",
      enabled: true,
      hookNames: ["before_tool_call"],
      contracts: exact,
      manifest: { contracts: extra },
    },
    {
      id: "agent-guard-supervision",
      enabled: true,
      hookNames: ["before_tool_call"],
      contracts: extra,
      manifest: { contracts: exact },
    },
    {
      id: "agent-guard-supervision",
      enabled: true,
      hookNames: ["before_tool_call"],
      contracts: exact,
      manifest: { contracts: { trustedToolPolicies: false } },
    },
  ];

  for (const plugin of plugins) {
    const client = createOpenClawControlClient({
      gatewayToken: TOKEN,
      commandRunner: commandRunner([
        result("2026.7.2"),
        result(JSON.stringify([plugin])),
      ]),
    });
    const capability = await client.inspectCapabilities({ isolatedProfile: false });
    assert.equal(capability.supportsNativeGuard, false);
    assert.equal(capability.finalizerAssurance, "unverified");
  }
});

test("requires version 2026.7.2 or newer even when the plugin contract is present", async () => {
  const client = createOpenClawControlClient({
    gatewayToken: TOKEN,
    commandRunner: commandRunner([
      result("2026.6.1"),
      result(JSON.stringify([agentGuardPlugin()])),
    ]),
  });
  const capability = await client.inspectCapabilities({ isolatedProfile: false });
  assert.equal(capability.supportsNativeGuard, false);
  assert.equal(capability.openclawVersion, "2026.6.1");

  const prerelease = createOpenClawControlClient({
    gatewayToken: TOKEN,
    commandRunner: commandRunner([
      result("2026.7.2-beta.1"),
      result(JSON.stringify([agentGuardPlugin()])),
    ]),
  });
  const prereleaseCapability = await prerelease.inspectCapabilities({ isolatedProfile: false });
  assert.equal(prereleaseCapability.openclawVersion, "2026.7.2-beta.1");
  assert.equal(prereleaseCapability.supportsNativeGuard, false);
});

test("reports an exclusive hook and detects a second enabled before_tool_call plugin", async () => {
  const exclusive = createOpenClawControlClient({
    gatewayToken: TOKEN,
    commandRunner: commandRunner([
      result("2026.7.3"),
      result(JSON.stringify(liveInventory([agentGuardPlugin()]))),
    ]),
  });
  assert.deepEqual(await exclusive.inspectCapabilities({ isolatedProfile: false }), {
    openclawVersion: "2026.7.3",
    supportsNativeGuard: true,
    finalizerAssurance: "exclusive_before_hook",
    conflictingPluginIds: [],
  });

  const conflicting = createOpenClawControlClient({
    gatewayToken: TOKEN,
    commandRunner: commandRunner([
      result("2026.7.3"),
      result(JSON.stringify(liveInventory([
        agentGuardPlugin(),
        { id: "other-guard", enabled: true, hookNames: ["before_tool_call"] },
      ]))),
    ]),
  });
  const capability = await conflicting.inspectCapabilities({ isolatedProfile: false });
  assert.equal(capability.finalizerAssurance, "unverified");
  assert.deepEqual(capability.conflictingPluginIds, ["other-guard"]);
});

test("grants isolated assurance only for the exact enabled Agent Guard allowlist", async () => {
  const exact = createOpenClawControlClient({
    gatewayToken: TOKEN,
    commandRunner: commandRunner([
      result("2026.8.0"),
      result(JSON.stringify(liveInventory([agentGuardPlugin()]))),
    ]),
  });
  assert.equal(
    (await exact.inspectCapabilities({ isolatedProfile: true })).finalizerAssurance,
    "isolated_profile",
  );

  const extra = createOpenClawControlClient({
    gatewayToken: TOKEN,
    commandRunner: commandRunner([
      result("2026.8.0"),
      result(JSON.stringify(liveInventory([
        agentGuardPlugin(),
        { id: "unrelated", enabled: true, hookNames: [] },
      ]))),
    ]),
  });
  const extraCapability = await extra.inspectCapabilities({ isolatedProfile: true });
  assert.equal(extraCapability.supportsNativeGuard, false);
  assert.equal(extraCapability.finalizerAssurance, "unverified");
});

test("accepts a bounded real-size live inventory without widening version output", async () => {
  const calls: Parameters<OpenClawCommandRunner>[0][] = [];
  const inventory = liveInventory([{
    ...agentGuardPlugin(),
    hostMetadata: "x".repeat(150_000),
  }]);
  const runner: OpenClawCommandRunner = async (input) => {
    calls.push(input);
    return calls.length === 1
      ? result("2026.7.2")
      : result(JSON.stringify(inventory));
  };
  const client = createOpenClawControlClient({
    gatewayToken: TOKEN,
    commandRunner: runner,
  });

  const capability = await client.inspectCapabilities({ isolatedProfile: false });

  assert.equal(capability.supportsNativeGuard, true);
  assert.equal(calls[0].maxOutputBytes, 64 * 1024);
  assert.equal(calls[1].maxOutputBytes, 512 * 1024);
});

test("rejects capability inventory above its dedicated bounded output budget", async () => {
  const inventory = liveInventory([{
    ...agentGuardPlugin(),
    hostMetadata: "x".repeat(512 * 1024),
  }]);
  const client = createOpenClawControlClient({
    gatewayToken: TOKEN,
    commandRunner: commandRunner([
      result("2026.7.2"),
      result(JSON.stringify(inventory)),
    ]),
  });

  await assert.rejects(
    () => client.inspectCapabilities({ isolatedProfile: false }),
    hasCode("OPENCLAW_CLI_OUTPUT_TOO_LARGE"),
  );
});

test("bounds injected CLI runners and reports malformed, oversized, and failed output stably", async () => {
  const timed = createOpenClawControlClient({
    gatewayToken: TOKEN,
    timeoutMs: 5,
    commandRunner: async () => new Promise(() => undefined),
  });
  await assert.rejects(
    () => timed.inspectCapabilities({ isolatedProfile: false }),
    hasCode("OPENCLAW_CLI_TIMEOUT"),
  );

  for (const results of [
    [result("2026.7.2"), result("not-json")],
    [result("2026.7.2"), result("x".repeat(65_537))],
    [result("2026.7.2"), result("", 1)],
    [result("2026.7.2", 0), { exitCode: 0, stdout: "x".repeat(40_000), stderr: "x".repeat(40_000) }],
  ]) {
    const client = createOpenClawControlClient({
      gatewayToken: TOKEN,
      commandRunner: commandRunner(results),
    });
    await assert.rejects(
      () => client.inspectCapabilities({ isolatedProfile: false }),
      (error: unknown) => error instanceof OpenClawControlClientError &&
        !error.message.includes(TOKEN),
    );
  }
});

test("round-trips a deferred scoped activation through activeLeases", async () => {
  const requestSeen = deferred<NativeGuardLeaseActivation>();
  const releaseResponse = deferred<void>();
  const activation: NativeGuardLeaseActivation = {
    ...ACTIVATION,
    rootSessionKey: "agent:main:main",
    scope: { kind: "agent", agentId: "main" },
  };
  const client = createOpenClawControlClient({
    gatewayToken: TOKEN,
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as NativeGuardLeaseActivation;
      requestSeen.resolve(body);
      await releaseResponse.promise;
      return jsonResponse(activeStatus(body));
    },
  });

  const pending = client.activate("http://localhost", activation);
  assert.deepEqual((await requestSeen.promise).scope, activation.scope);
  releaseResponse.resolve();

  const status = await pending;
  assert.deepEqual(status.activeLeases?.[0]?.scope, activation.scope);
  assert.deepEqual(status.activeLease?.scope, activation.scope);
});

test("strictly validates scoped activeLeases summaries and array invariants", async () => {
  const first = activeStatus({
    ...ACTIVATION,
    rootSessionKey: "agent:main:main",
    scope: { kind: "agent", agentId: "main" },
  });
  const secondActivation: NativeGuardLeaseActivation = {
    ...ACTIVATION,
    leaseId: "lease-2",
    rootSessionKey: "agent:sandbox:session-2",
    scope: { kind: "session", sessionKey: "agent:sandbox:session-2" },
  };
  const second = activeStatus(secondActivation).activeLeases![0];
  const multiple: NativeGuardStatus = {
    ...first,
    activeLeaseCount: 2,
    activeLeases: [first.activeLeases![0], second],
    activeLease: undefined,
  };
  const invalid: unknown[] = [];

  const unscoped = structuredClone(first) as NativeGuardStatus;
  delete (unscoped.activeLeases![0] as unknown as Record<string, unknown>).scope;
  invalid.push(unscoped);

  const extraScopeKey = structuredClone(first) as NativeGuardStatus;
  (extraScopeKey.activeLeases![0].scope as unknown as Record<string, unknown>).extra = true;
  invalid.push(extraScopeKey);

  invalid.push({ ...multiple, activeLeaseCount: 1 });
  invalid.push({ ...multiple, activeLeases: [multiple.activeLeases![0], multiple.activeLeases![0]] });
  invalid.push({ ...multiple, activeLease: first.activeLease });
  invalid.push({ ...first, activeLease: undefined });
  invalid.push({
    ...first,
    activeLease: { ...first.activeLease!, policyPackDigest: "different" },
  });
  invalid.push({
    ...first,
    activeLeases: [{
      ...first.activeLease!,
      rootSessionKey: "agent:main:not-the-anchor",
    }],
    activeLease: {
      ...first.activeLease!,
      rootSessionKey: "agent:main:not-the-anchor",
    },
  });
  invalid.push(activeStatus({
    ...secondActivation,
    rootSessionKey: "agent:sandbox:different",
  }));

  for (const value of invalid) {
    const client = createOpenClawControlClient({
      gatewayToken: TOKEN,
      fetch: async () => jsonResponse(value),
    });
    await assert.rejects(
      () => client.status("http://localhost"),
      hasCode("OPENCLAW_CONTROL_INVALID_RESPONSE"),
    );
  }
});

test("accepts an unscoped legacy activeLease only when activeLeases is absent", async () => {
  const legacy = structuredClone(activeStatus(ACTIVATION)) as NativeGuardStatus;
  delete (legacy as unknown as Record<string, unknown>).activeLeases;
  delete (legacy.activeLease as unknown as Record<string, unknown>).scope;
  const legacyClient = createOpenClawControlClient({
    gatewayToken: TOKEN,
    fetch: async () => jsonResponse(legacy),
  });

  const parsed = await legacyClient.status("http://localhost");
  assert.equal(parsed.activeLeases, undefined);
  assert.equal(parsed.activeLease?.scope, undefined);

  const invalidLegacyCounts: unknown[] = [
    { ...legacy, activeLeaseCount: 0 },
    { ...legacy, activeLeaseCount: 1, activeLease: undefined },
    { ...legacy, activeLeaseCount: 2, activeLease: undefined },
    { ...legacy, activeLeaseCount: 2 },
  ];
  for (const value of invalidLegacyCounts) {
    const client = createOpenClawControlClient({
      gatewayToken: TOKEN,
      fetch: async () => jsonResponse(value),
    });
    await assert.rejects(
      () => client.status("http://localhost"),
      hasCode("OPENCLAW_CONTROL_INVALID_RESPONSE"),
    );
  }

  const mixed = structuredClone(activeStatus(ACTIVATION)) as NativeGuardStatus;
  delete (mixed.activeLease as unknown as Record<string, unknown>).scope;
  const mixedClient = createOpenClawControlClient({
    gatewayToken: TOKEN,
    fetch: async () => jsonResponse(mixed),
  });
  await assert.rejects(
    () => mixedClient.status("http://localhost"),
    hasCode("OPENCLAW_CONTROL_INVALID_RESPONSE"),
  );
});

test("uses the enabled static inventory only for an isolated profile", async () => {
  const calls: string[][] = [];
  const runner: OpenClawCommandRunner = async (input) => {
    calls.push(input.args);
    if (input.args.length === 1 && input.args[0] === "--version") {
      return result("2026.7.2");
    }
    if (input.args.join(" ") === "plugins list --enabled --json") {
      return result(JSON.stringify(liveInventory([agentGuardPlugin()])));
    }
    if (input.args.join(" ") === "plugins list --json") {
      return result("x".repeat(65_537));
    }
    return result("", 1);
  };
  const client = createOpenClawControlClient({ gatewayToken: TOKEN, commandRunner: runner });

  const capability = await client.inspectCapabilities({
    cliPath: process.execPath,
    isolatedProfile: true,
  });

  assert.equal(capability.supportsNativeGuard, true);
  assert.deepEqual(calls, [
    ["--version"],
    ["plugins", "list", "--enabled", "--json"],
  ]);
});

test("passes CLI arguments separately and preserves the resolver's no-shell invocation", async () => {
  const calls: Parameters<OpenClawCommandRunner>[0][] = [];
  const runner: OpenClawCommandRunner = async (input) => {
    calls.push(input);
    return calls.length === 1 ? result("2026.7.2") : result(JSON.stringify([agentGuardPlugin()]));
  };
  const client = createOpenClawControlClient({ gatewayToken: TOKEN, commandRunner: runner });

  await client.inspectCapabilities({
    cliPath: process.execPath,
    env: { INSPECTION_MARKER: "separate-value" },
    isolatedProfile: false,
  });

  assert.equal(calls[0].shell, false);
  assert.deepEqual(calls[0].args, ["--version"]);
  assert.deepEqual(calls[1].args, ["plugins", "list", "--json", "--live"]);
  assert.equal(calls[0].env.INSPECTION_MARKER, "separate-value");
});

test("rejects every duplicate plugin id in the CLI inventory", async () => {
  const inventories = [
    [agentGuardPlugin(), agentGuardPlugin()],
    [
      agentGuardPlugin(),
      { id: "duplicate-other", enabled: false, hookNames: [] },
      { id: "duplicate-other", enabled: true, hookNames: ["before_tool_call"] },
    ],
  ];
  for (const inventory of inventories) {
    const client = createOpenClawControlClient({
      gatewayToken: TOKEN,
      commandRunner: commandRunner([
        result("2026.7.2"),
        result(JSON.stringify(inventory)),
      ]),
    });
    await assert.rejects(
      () => client.inspectCapabilities({ isolatedProfile: false }),
      hasCode("OPENCLAW_CLI_INVALID_OUTPUT"),
    );
  }
});

function agentGuardPlugin(): Record<string, unknown> {
  return {
    id: "agent-guard-supervision",
    enabled: true,
    hookNames: ["before_tool_call"],
    contracts: { trustedToolPolicies: ["agent-guard-admission"] },
  };
}

function coldForkAgentGuardPlugin(): Record<string, unknown> {
  return {
    id: "agent-guard-supervision",
    enabled: true,
    status: "loaded",
    hookNames: [],
    manifest: {
      contracts: { trustedToolPolicies: ["agent-guard-admission"] },
    },
  };
}

function liveInventory(
  plugins: Record<string, unknown>[],
  gatewayInstanceId?: string,
): Record<string, unknown> {
  return {
    plugins,
    registry: {
      liveAttestation: true,
      ...(gatewayInstanceId ? { gatewayInstanceId } : {}),
      nativeGuard: {
        contractVersion: "native-guard-1",
        registrarStatus: "live",
        finalBeforeToolCall: {
          pluginId: "agent-guard-supervision",
          exclusive: true,
        },
        trustedToolPolicy: {
          policyId: "agent-guard-admission",
          exclusive: true,
        },
        recoveryService: {
          serviceId: "agent-guard-runtime",
          live: true,
        },
        postApprovalLeaseRecheck: true,
        paramsProvenance: "json-only",
      },
    },
  };
}

async function inspectInventory(inventory: unknown) {
  const client = createOpenClawControlClient({
    gatewayToken: TOKEN,
    commandRunner: commandRunner([
      result("2026.7.2"),
      result(JSON.stringify(withLiveCapability(inventory))),
    ]),
  });
  return client.inspectCapabilities({ isolatedProfile: false });
}

function withLiveCapability(inventory: unknown): unknown {
  if (Array.isArray(inventory)) return liveInventory(inventory);
  if (typeof inventory !== "object" || inventory === null) return inventory;
  const record = inventory as Record<string, unknown>;
  if (
    record.registry !== undefined &&
    (typeof record.registry !== "object" ||
      record.registry === null ||
      Array.isArray(record.registry))
  ) {
    return inventory;
  }
  const live = liveInventory([]).registry as Record<string, unknown>;
  return {
    ...record,
    registry: {
      ...((record.registry as Record<string, unknown> | undefined) ?? {}),
      ...live,
    },
  };
}

function commandRunner(results: Array<{ exitCode: number; stdout: string; stderr: string }>): OpenClawCommandRunner {
  let index = 0;
  return async () => results[index++] ?? result("", 1);
}

function result(stdout: string, exitCode = 0): { exitCode: number; stdout: string; stderr: string } {
  return { exitCode, stdout, stderr: "" };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function gatewayAttestation(gatewayUrl: string, challenge: string): Record<string, unknown> {
  const unsigned = {
    contractVersion: "native-guard-gateway-1",
    signatureContext: "native_guard.gateway_attestation.v1",
    challenge,
    gatewayUrl,
    gatewayInstanceId: "gateway.instance.1",
    openclawVersion: "2026.7.1-agentguard.1",
    nativeGuard: (liveInventory([]).registry as Record<string, unknown>).nativeGuard,
  };
  return {
    ...unsigned,
    signature: signNativeGuardPayload(unsigned, TEST_ATTESTATION_KEYS.privateKey),
  };
}

function cancellableResponse(options: {
  status: number;
  contentType: string;
  contentLength?: string;
}) {
  let cancelCount = 0;
  const value = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("{}"));
    },
    cancel() {
      cancelCount += 1;
    },
  }), {
    status: options.status,
    headers: {
      "content-type": options.contentType,
      ...(options.contentLength ? { "content-length": options.contentLength } : {}),
    },
  });
  return { value, cancelled: () => cancelCount };
}

function neverSettlingCancelResponse(options: {
  status: number;
  headers: Record<string, string>;
  body?: Uint8Array;
}): { value: Response; cancelled: () => number } {
  let cancelCount = 0;
  const value = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(options.body ?? new TextEncoder().encode("{}"));
    },
    cancel() {
      cancelCount += 1;
      return new Promise<void>(() => undefined);
    },
  }), {
    status: options.status,
    headers: options.headers,
  });
  return { value, cancelled: () => cancelCount };
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("OpenClaw control request did not settle in time.")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof OpenClawControlClientError && error.code === code;
}

function readyStatus(): NativeGuardStatus {
  return {
    coverage: "ready",
    finalizerAssurance: "exclusive_before_hook",
    openclawVersion: "2026.7.2",
    pluginVersion: "1.0.0",
    activeLeaseCount: 0,
    conflictingPluginIds: [],
  };
}

function activeStatus(activation: NativeGuardLeaseActivation): NativeGuardStatus {
  const activeLease = {
    leaseId: activation.leaseId,
    leaseEpoch: activation.leaseEpoch,
    rootSessionKey: activation.rootSessionKey,
    scope: activation.scope,
    mode: activation.mode,
    policyPackId: activation.policyPackId,
    policyPackDigest: activation.policyPackDigest,
    expiresAt: activation.expiresAt,
  };
  return {
    ...readyStatus(),
    coverage: "active",
    activeLeaseCount: 1,
    activeLeases: [activeLease],
    activeLease,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => { resolve = innerResolve; });
  return { promise, resolve };
}

const ACTIVATION: NativeGuardLeaseActivation = {
  schemaVersion: "native-guard-1",
  leaseId: "lease-1",
  leaseEpoch: 3,
  rootSessionKey: "agent:main",
  mode: "supervision",
  scope: "session_tree",
  policyPackId: "policy-1",
  policyPackDigest: "sha256:policy",
  backendUrl: "http://127.0.0.1:3000",
  decisionPublicKey: "public-key",
  failurePolicy: { lowRisk: "warn", highRisk: "deny", unknownRisk: "deny" },
  issuedAt: "2026-08-02T00:00:00.000Z",
  expiresAt: "2026-08-02T00:05:00.000Z",
  credential: "lease-secret",
  evidenceCredential: "evidence-secret",
  evidenceSigningKeyId: "evidence.control-client",
  evidenceSigningPrivateKey: "private-key",
};
