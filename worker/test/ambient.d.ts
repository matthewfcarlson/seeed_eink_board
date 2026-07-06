// Minimal ambient stubs so test/tsconfig.json (Node types only, deliberately
// without @cloudflare/workers-types to avoid its global fetch/Response/etc.
// overrides conflicting with @types/node) can still typecheck src/types.ts
// when test files transitively import from src/lib/*. Never used at runtime.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type D1Database = any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type KVNamespace = any;
}

export {};
