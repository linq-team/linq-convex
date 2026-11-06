/**
 * Calls to the Linq Partner API from the component's actions. Plain `fetch`,
 * so it runs in Convex's default runtime with no `"use node"`.
 */

export const DEFAULT_BASE_URL = "https://api.linqapp.com/api/partner";

/**
 * Delay before each in-call retry. Kept short: a reply usually runs inside a
 * webhook request, and Linq times webhooks out after 10 seconds.
 */
export const RETRY_DELAYS_MS = [500, 2_000];
/** Deadline for one HTTP attempt, response body included. */
export const REQUEST_TIMEOUT_MS = 10_000;
/** Longest Retry-After the in-call retry will wait for. */
export const MAX_RETRY_AFTER_MS = 5_000;

export type CallResult =
  | { ok: true; body: unknown }
  | { ok: false; retryable: boolean; status?: number; error: string; retryAfterMs?: number };

export interface Credentials {
  apiKey: string;
  baseUrl?: string;
}

function errorCode(text: string): number | undefined {
  try {
    const code = JSON.parse(text)?.error?.code;
    return typeof code === "number" && Number.isSafeInteger(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

function retryableStatus(status: number, code?: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500 ||
    (status === 409 && code === 2009);
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
      const code = errorCode(text);
      return {
        ok: false,
        retryable: retryableStatus(response.status, code),
        status: response.status,
        error: `HTTP ${response.status}${code === undefined ? "" : ` (code ${code})`}`,
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
  } catch {
    return {
      ok: false,
      retryable: true,
      error: "request timed out or could not connect",
    };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
