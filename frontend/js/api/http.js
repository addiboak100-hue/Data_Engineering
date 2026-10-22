// Small fetch wrapper: timeouts, typed errors, JSON parsing.

export class ApiError extends Error {
  /**
   * @param {string} message  human-readable, safe to show in the UI
   * @param {{kind: "network"|"timeout"|"http"|"rate_limit"|"invalid", status?: number, retryAfter?: number}} info
   */
  constructor(message, info) {
    super(message);
    this.name = "ApiError";
    this.kind = info.kind;
    this.status = info.status;
    this.retryAfter = info.retryAfter;
  }
}

export async function fetchJson(url, { method = "GET", body, timeoutMs = 15_000, signal } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
  const onAbort = () => controller.abort(signal.reason);
  signal?.addEventListener("abort", onAbort, { once: true });

  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json", Accept: "application/json" } : { Accept: "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted && controller.signal.reason === "timeout") {
      throw new ApiError("The request timed out.", { kind: "timeout" });
    }
    if (signal?.aborted) throw err;
    throw new ApiError("Couldn't reach the server.", { kind: "network" });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after")) || 60;
    throw new ApiError("Rate limit reached.", { kind: "rate_limit", status: 429, retryAfter });
  }

  let data = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new ApiError("The server sent a response that isn't JSON.", { kind: "invalid", status: res.status });
    }
  }

  if (!res.ok) {
    const detail = data && (data.detail || data.error || data.message);
    const msg = typeof detail === "string" ? detail : `Request failed with status ${res.status}.`;
    throw new ApiError(msg, { kind: "http", status: res.status });
  }
  return data;
}
