export function isEntryScript(argv1: string | undefined, suffixes: string[]): boolean {
  if (!argv1) return false;
  const normalized = argv1.replace(/\\/g, '/');
  return suffixes.some((suffix) => normalized.endsWith(suffix));
}
