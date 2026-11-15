export class AnchorError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: unknown,
  ) {
    super(message);
  }
}

type Body = FormData | Record<string, unknown> | undefined;

/** Sends `{url}/api{path}` with a bearer token; non-2xx responses become AnchorError. */
async function send(url: string, token: string | null, method: string, path: string, body: Body, timeoutMs: number) {
  const isForm = body instanceof FormData;
  let res: Response;
  try {
    res = await fetch(`${url}/api${path}`, {
      method,
      headers: {
        ...(token && { Authorization: `Bearer ${token}` }),
        ...(body !== undefined && !isForm && { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new AnchorError(0, `Could not reach Anchor at ${url}: ${(e as Error).message}`, null);
  }
  if (res.ok) return res;
  const text = await res.text();
  let data: any = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON body (e.g. a proxy error page)
  }
  const detail =
    typeof data === "object" && data?.message
      ? data.message
      : /^\s*</.test(text)
        ? "got a web page instead of the Anchor API (check the URL)"
        : String(text).slice(0, 300);
  throw new AnchorError(res.status, `Anchor returned HTTP ${res.status}: ${detail}`, data);
}

/** JSON request; FormData bodies go out as multipart (uploads get a longer timeout). */
export async function anchorRequest<T = any>(
  url: string,
  token: string | null,
  method: string,
  path: string,
  body?: Body,
): Promise<T> {
  const res = await send(url, token, method, path, body, body instanceof FormData ? 300_000 : 20_000);
  const text = await res.text();
  try {
    return (text ? JSON.parse(text) : null) as T;
  } catch {
    return text as T;
  }
}

/** Binary GET (attachments, exports). */
export async function anchorDownload(url: string, token: string, path: string) {
  const res = await send(url, token, "GET", path, undefined, 300_000);
  const disposition = res.headers.get("content-disposition") ?? "";
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1];
  return {
    bytes: Buffer.from(await res.arrayBuffer()),
    mimeType: res.headers.get("content-type")?.split(";")[0] ?? "application/octet-stream",
    filename: filename ? decodeURIComponent(filename) : undefined,
  };
}
