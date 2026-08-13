// Minimal typing for workerd's nodejs_compat AsyncLocalStorage (used by
// request-cache.server.ts). Deliberately NOT `"types": ["node"]` in tsconfig:
// that would pull every Node global (process, Buffer, NodeJS.Timeout) into the
// same type space as the DOM-typed client components.
declare module "node:async_hooks" {
  export class AsyncLocalStorage<T> {
    run<R>(store: T, callback: () => R): R;
    getStore(): T | undefined;
  }
}
