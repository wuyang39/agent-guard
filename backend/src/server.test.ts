import assert from "node:assert/strict";
import test from "node:test";
import { createNativeSupervisionServerBootstrap } from "./server";

test("server fallback creates one local pairing fragment without a supplied bootstrap", () => {
  const bootstrap = createNativeSupervisionServerBootstrap(
    { FRONTEND_PORT: "5199" },
    () => "b".repeat(43),
  );

  assert.deepEqual(bootstrap, {
    bootstrapToken: "b".repeat(43),
    pairingOrigin: "http://127.0.0.1:5199",
    pairingUrl: `http://127.0.0.1:5199/#agent-guard-bootstrap=${"b".repeat(43)}`,
  });
  assert.doesNotMatch(bootstrap.pairingUrl!, /[?&]agent-guard-bootstrap=/);
});

test("server uses a launcher bootstrap without generating or formatting another secret URL", () => {
  let generated = 0;
  const bootstrap = createNativeSupervisionServerBootstrap(
    { AGENT_GUARD_UI_BOOTSTRAP_TOKEN: "l".repeat(43) },
    () => {
      generated += 1;
      return "x".repeat(43);
    },
  );

  assert.deepEqual(bootstrap, { bootstrapToken: "l".repeat(43) });
  assert.equal(generated, 0);
  assert.equal(bootstrap.pairingUrl, undefined);
});

test("server fallback rejects malformed generated tokens and frontend ports", () => {
  assert.throws(
    () => createNativeSupervisionServerBootstrap({}, () => "short"),
    /bootstrap token/,
  );
  assert.throws(
    () => createNativeSupervisionServerBootstrap(
      { FRONTEND_PORT: "70000" },
      () => "b".repeat(43),
    ),
    /FRONTEND_PORT/,
  );
});
