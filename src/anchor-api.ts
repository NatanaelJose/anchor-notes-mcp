export class AnchorError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: unknown,
  ) {
    super(message);
  }
}

/** Calls `{url}/api{path}` with a bearer token and returns the parsed JSON body. */
export async function anchorRequest<T = any>(
  url: string,
  token: string | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${url}/api${path}`, {
      method,
      headers: {
        ...(token && { Authorization: `Bearer ${token}` }),
        ...(body !== undefined && { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw new AnchorError(0, `Could not reach Anchor at ${url}: ${(e as Error).message}`, null);
  }
  const text = await res.text();
  let data: any = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON body (e.g. a proxy error page)
  }
  if (!res.ok) {
    const detail = typeof data === "object" && data?.message ? data.message : String(text).slice(0, 300);
    throw new AnchorError(res.status, `Anchor returned HTTP ${res.status}: ${detail}`, data);
  }
  return data as T;
}
