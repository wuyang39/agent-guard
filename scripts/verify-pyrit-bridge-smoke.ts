import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { resolvePyritRuntimeEnv } from "../backend/src/modules/corpus";

const rootDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const vendorDir = path.resolve(rootDir, "third_party", "pyrit_adapted");
const runtime = resolvePyritRuntimeEnv(rootDir);
const compileTargets = [
  "run_attack_cli.py",
  "agent_guard_bridge.py",
  "api.py",
  "evaluator.py",
  "pyrit/prompt_converter/atbash_converter.py",
  "pyrit/prompt_converter/binary_converter.py",
  "pyrit/prompt_converter/base2048_converter.py",
  "pyrit/prompt_converter/ask_to_decode_converter.py",
  "pyrit/prompt_converter/morse_converter.py",
  "pyrit/prompt_converter/unicode_confusable_converter.py",
  "pyrit/prompt_converter/unicode_sub_converter.py",
  "pyrit/prompt_converter/token_smuggling/sneaky_bits_smuggler_converter.py",
  "pyrit/prompt_converter/flip_converter.py",
].map((relativePath) => path.join(vendorDir, relativePath));

const compileResult = spawnSync(
  runtime.pythonCommand,
  [...runtime.pythonArgsPrefix, "-m", "py_compile", ...compileTargets],
  {
    cwd: rootDir,
    encoding: "utf8",
    windowsHide: true,
  },
);
assert(
  compileResult.status === 0,
  `PyRIT bridge Python compile failed with ${runtime.displayName}: ${compileResult.stderr || compileResult.stdout}`,
);

const bridgeSource = await readFile(path.join(vendorDir, "agent_guard_bridge.py"), "utf8");
for (const requiredSnippet of ["converter_batch", "attack_cli", "DeepSeek_API_2", "run_attack_cli.py"]) {
  assert(bridgeSource.includes(requiredSnippet), `agent_guard_bridge.py should include ${requiredSnippet}`);
}

const cliSource = await readFile(path.join(vendorDir, "run_attack_cli.py"), "utf8");
for (const method of [
  "prompt_sending",
  "flip",
  "red_teaming",
  "crescendo",
  "context_compliance",
  "role_play",
  "many_shot_jailbreak",
  "renellm",
]) {
  assert(cliSource.includes(`"${method}"`), `run_attack_cli.py should expose method ${method}`);
}

console.log(`PASS: PyRIT bridge smoke check with ${runtime.displayName}`);

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}
