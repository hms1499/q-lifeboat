/** The browser's localStorage, or undefined when it is blocked (private mode). */
export function browserStorage(): { getItem(k: string): string | null; setItem(k: string, v: string): void } | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
