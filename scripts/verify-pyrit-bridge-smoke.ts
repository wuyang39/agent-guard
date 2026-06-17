import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

type PythonCommand = {
  command: string;
  argsPrefix: string[];
  displayName: string;
};

const rootDir = process.cwd();
const vendorDir = path.resolve(rootDir, "third_party", "pyrit_adapted");
const compileTargets = [
  "run_attack_cli.py",
  "api.py",
  "evaluator.py",
  "pyrit/prompt_converter/atbash_converter.py",
  "pyrit/prompt_converter/binary_converter.py",
  "pyrit/prompt_converter/morse_converter.py",
  "pyrit/prompt_converter/unicode_confusable_converter.py",
  "pyrit/prompt_converter/flip_converter.py",
].map((relativePath) => path.join(vendorDir, relativePath));

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  const python = findPython();
  if (!python) {
    console.log("SKIP: Python executable not found; PyRIT bridge smoke check is optional in P2.");
    return;
  }

  const compileResult = spawnSync(
    python.command,
    [...python.argsPrefix, "-m", "py_compile", ...compileTargets],
    {
      cwd: rootDir,
      encoding: "utf8",
      windowsHide: true,
    },
  );
  assert(
    compileResult.status === 0,
    `PyRIT bridge Python compile failed with ${python.displayName}: ${compileResult.stderr || compileResult.stdout}`,
  );

  const apiSource = await readFile(path.join(vendorDir, "api.py"), "utf8");
  assert(
    apiSource.includes("未找到 attack_runner.py"),
    "api.py should explicitly report that the batch attack runner is unavailable until a controlled bridge is implemented.",
  );

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

  console.log(`PASS: optional PyRIT bridge smoke check with ${python.displayName}`);
}

function findPython(): PythonCommand | undefined {
  const candidates: PythonCommand[] = [
    { command: "python", argsPrefix: [], displayName: "python" },
    { command: "py", argsPrefix: ["-3"], displayName: "py -3" },
  ];

  for (const candidate of candidates) {
    const result = spawnSync(
      candidate.command,
      [...candidate.argsPrefix, "--version"],
      {
        encoding: "utf8",
        windowsHide: true,
      },
    );
    if (result.status === 0) {
      return candidate;
    }
  }

  return undefined;
}

main().catch((error) => {
  console.error("FAIL:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
