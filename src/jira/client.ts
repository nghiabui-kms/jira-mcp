import type { JiraAuth } from "./auth.js";

export class JiraError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "JiraError";
  }
}

type Query = Record<string, string | number | boolean | undefined>;

const MAX_RETRIES = 2;

export class JiraClient {
  constructor(private readonly auth: JiraAuth) {}

  get<T>(path: string, query?: Query): Promise<T> {
    return this.request<T>("GET", path, query);
  }

  post<T>(path: string, body?: unknown, query?: Query): Promise<T> {
    return this.request<T>("POST", path, query, body);
  }

  put<T>(path: string, body?: unknown, query?: Query): Promise<T> {
    return this.request<T>("PUT", path, query, body);
  }

  delete<T>(path: string, query?: Query): Promise<T> {
    return this.request<T>("DELETE", path, query);
  }

  /** The Location a GET redirects to (e.g. attachment content -> media URL), without following it. */
  async redirectLocation(path: string): Promise<string | undefined> {
    const res = await fetch(this.auth.baseUrl + path, {
      headers: await this.auth.headers(),
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status >= 400) throw new JiraError(res.status, formatError(res.status, await res.text()));
    return res.headers.get("location") ?? undefined;
  }

  private async request<T>(
    method: string,
    path: string,
    query?: Query,
    body?: unknown,
    attempt = 0,
  ): Promise<T> {
    const url = new URL(this.auth.baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }

    // FormData = multipart upload: fetch sets the boundary, Jira requires the XSRF opt-out header.
    const form = body instanceof FormData;
    const res = await fetch(url, {
      method,
      headers: {
        Accept: "application/json",
        ...(form ? { "X-Atlassian-Token": "no-check" } : {}),
        ...(body !== undefined && !form ? { "Content-Type": "application/json" } : {}),
        ...(await this.auth.headers()),
      },
      body: form ? body : body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });

    // Jira Cloud rate limit: the request was not processed, so retrying is safe.
    if (res.status === 429 && attempt < MAX_RETRIES) {
      const retryAfter = Number(res.headers.get("Retry-After")) || 2 ** (attempt + 1);
      await new Promise((r) => setTimeout(r, Math.min(retryAfter, 30) * 1000));
      return this.request<T>(method, path, query, body, attempt + 1);
    }

    const text = await res.text();
    if (!res.ok) throw new JiraError(res.status, formatError(res.status, text));
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

function formatError(status: number, text: string): string {
  let detail = text.slice(0, 500);
  try {
    const j = JSON.parse(text) as {
      errorMessages?: string[];
      errors?: Record<string, string>;
      message?: string;
    };
    const parts = [
      ...(j.errorMessages ?? []),
      ...Object.entries(j.errors ?? {}).map(([field, msg]) => `${field}: ${msg}`),
      ...(j.message ? [j.message] : []),
    ];
    if (parts.length) detail = parts.join("; ");
  } catch {
    // not JSON, keep raw text
  }
  const hints: Record<number, string> = {
    401: " (check JIRA_EMAIL / JIRA_API_TOKEN, the token may have expired)",
    403: " (the account has no permission for this action)",
    404: " (not found, or the account cannot see it)",
  };
  return `Jira ${status}${hints[status] ?? ""}: ${detail}`;
}
