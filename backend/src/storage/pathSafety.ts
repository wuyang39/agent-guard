import path from "node:path";

export function isPathInsideDirectory(targetPath: string, baseDir: string): boolean {
  const base = path.resolve(baseDir);
  const target = path.resolve(targetPath);
  const relative = path.relative(base, target);
  return relative === "" || (Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative));
}

export function resolveInsideDirectory(baseDir: string, ...segments: string[]): string {
  const base = path.resolve(baseDir);
  const target = path.resolve(base, ...segments);
  if (!isPathInsideDirectory(target, base)) {
    throw new Error(`Resolved path is outside ${base}.`);
  }
  return target;
}

