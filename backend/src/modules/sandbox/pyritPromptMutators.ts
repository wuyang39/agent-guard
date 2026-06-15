import type { JsonObject } from "@agent-guard/contracts";

export type PyritMutationResult = {
  converterId: string;
  input: string;
  output: string;
  metadata: JsonObject;
};

export const PYRIT_NATIVE_CONVERTER_IDS = [
  "pyrit.converter.base64",
  "pyrit.converter.rot13",
  "pyrit.converter.caesar_3",
  "pyrit.converter.leetspeak",
  "pyrit.converter.character_space",
  "pyrit.converter.zero_width",
  "pyrit.converter.string_join_dash",
  "pyrit.converter.suffix_append_marker",
  "pyrit.converter.url_encode",
  "pyrit.converter.ascii_smuggler_tags",
] as const;

export type PyritNativeConverterId = (typeof PYRIT_NATIVE_CONVERTER_IDS)[number];

export function applyPyritPromptConverter(
  converterId: string,
  prompt: string,
): PyritMutationResult {
  const output = convertPrompt(converterId, prompt);
  return {
    converterId,
    input: prompt,
    output,
    metadata: {
      source: "third_party/pyrit_adapted",
      deterministic: true,
      inputLength: prompt.length,
      outputLength: output.length,
    },
  };
}

export function buildPyritMutationSet(
  prompt: string,
  converterIds: readonly string[] = PYRIT_NATIVE_CONVERTER_IDS,
): PyritMutationResult[] {
  return converterIds.map((converterId) => applyPyritPromptConverter(converterId, prompt));
}

function convertPrompt(converterId: string, prompt: string): string {
  switch (converterId) {
    case "pyrit.converter.base64":
      return Buffer.from(prompt, "utf8").toString("base64");
    case "pyrit.converter.rot13":
      return rot13(prompt);
    case "pyrit.converter.caesar_3":
      return caesar(prompt, 3);
    case "pyrit.converter.leetspeak":
      return leetspeak(prompt);
    case "pyrit.converter.character_space":
      return characterSpace(prompt);
    case "pyrit.converter.zero_width":
      return prompt.split("").join(String.fromCharCode(0x200b));
    case "pyrit.converter.string_join_dash":
      return prompt
        .split(/\s+/)
        .map((word) => word.split("").join("-"))
        .join(" ");
    case "pyrit.converter.suffix_append_marker":
      return `${prompt} !!!`;
    case "pyrit.converter.url_encode":
      return encodeURIComponent(prompt);
    case "pyrit.converter.ascii_smuggler_tags":
      return asciiSmugglerTags(prompt);
    default:
      throw new Error(`Unsupported native PyRIT converter: ${converterId}`);
  }
}

function rot13(value: string): string {
  return value.replace(/[a-zA-Z]/g, (char) => {
    const base = char <= "Z" ? 65 : 97;
    return String.fromCharCode(((char.charCodeAt(0) - base + 13) % 26) + base);
  });
}

function caesar(value: string, offset: number): string {
  return value.replace(/[a-zA-Z0-9]/g, (char) => {
    const code = char.charCodeAt(0);
    if (code >= 48 && code <= 57) {
      return String.fromCharCode(((code - 48 + offset) % 10) + 48);
    }
    const base = code >= 65 && code <= 90 ? 65 : 97;
    return String.fromCharCode(((code - base + offset) % 26) + base);
  });
}

function leetspeak(value: string): string {
  const substitutions: Record<string, string> = {
    a: "4",
    b: "8",
    c: "(",
    e: "3",
    g: "9",
    i: "1",
    l: "1",
    o: "0",
    s: "5",
    t: "7",
    z: "2",
  };

  return value
    .split("")
    .map((char) => substitutions[char.toLowerCase()] ?? char)
    .join("");
}

function characterSpace(value: string): string {
  return value
    .split("")
    .join(" ")
    .replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g, "");
}

function asciiSmugglerTags(value: string): string {
  const startTag = String.fromCodePoint(0xe0001);
  const endTag = String.fromCodePoint(0xe007f);
  const encoded = [...value]
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code >= 0x20 && code <= 0x7e;
    })
    .map((char) => String.fromCodePoint(0xe0000 + char.charCodeAt(0)))
    .join("");
  return `${startTag}${encoded}${endTag}`;
}
