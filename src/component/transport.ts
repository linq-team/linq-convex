/**
 * Calls to the Linq Partner API from the component's actions. Plain `fetch`,
 * so it runs in Convex's default runtime with no `"use node"`.
 */

export const DEFAULT_BASE_URL = "https://api.linqapp.com/api/partner";

/** Delay before each retry. Its length is the retry budget. */
export const RETRY_DELAYS_MS = [2_000, 10_000, 30_000, 120_000, 600_000];
export const REQUEST_TIMEOUT_MS = 30_000;

export type CallResult =
  | { ok: true; body: unknown }
  | { ok: false; retryable: boolean; status?: number; error: string; retryAfterMs?: number };

export interface Credentials {
  apiKey: string;
  baseUrl?: string;
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

export async function linqRequest(
  creds: Credentials,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<CallResult> {
  const base = (creds.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    // Cover both the response headers and its body. fetch() can resolve before
    // a connection failure makes response.text() reject.
    const request = async (): Promise<CallResult> => {
      const response = await fetch(`${base}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${creds.apiKey}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      if (response.ok) {
        if (!text) return { ok: true, body: null };
        try {
          return { ok: true, body: JSON.parse(text) };
        } catch {
          return { ok: true, body: text };
        }
      }
      return {
        ok: false,
        retryable: retryableStatus(response.status),
        status: response.status,
        error: `${response.status} ${text.slice(0, 500)}`.trim(),
        retryAfterMs: retryAfterMs(response.headers.get("retry-after")),
      };
    };
    return await Promise.race([
      request(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error(`request timed out after ${REQUEST_TIMEOUT_MS}ms`));
        }, REQUEST_TIMEOUT_MS);
      }),
    ]);
  } catch (e) {
    return {
      ok: false,
      retryable: true,
      error: `network error: ${e instanceof Error ? e.message : String(e)}`,
    };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
