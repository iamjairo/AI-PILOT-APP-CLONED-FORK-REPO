// Minimal types for fuzzaldrin-plus (Pulsar's fuzzy scorer). No @types published.
declare module 'fuzzaldrin-plus' {
  interface FilterOptions {
    key?: string;
    maxResults?: number;
    maxInners?: number;
  }
  export function filter<T>(candidates: T[], query: string, options?: FilterOptions): T[];
  export function score(candidate: string, query: string): number;
  export function match(candidate: string, query: string): number[];
  export function wrap(candidate: string, query: string): string;
  const _default: {
    filter: typeof filter;
    score: typeof score;
    match: typeof match;
    wrap: typeof wrap;
  };
  export default _default;
}
