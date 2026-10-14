// Only the parts of Claude Code's mod API this package uses; Claude Code writes the full API per build into .claude-plugin/types/.
declare module 'claude-code' {
  export type Engine = {
    session: {
      id(): Promise<string>;
      compact(): Promise<{ skip?: unknown } | undefined>;
    };
    command: { run(args: { command: string }): Promise<unknown> };
    fs: {
      read(path: string): Promise<unknown>;
      write(path: string, text: string): Promise<void>;
    };
    clock: { now(): Promise<number>; every(ms: number, fn: () => void): unknown };
  };
  export type HookEvent = { [key: string]: unknown };
  export type Next = (e: HookEvent) => Promise<unknown>;
  export type Hook = ($: Engine, e: HookEvent, next: Next) => unknown;
  export type On = (event: string, hook: Hook) => void;
}
