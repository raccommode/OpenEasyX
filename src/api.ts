export function apiHeaders(options?: RequestInit): Headers {
  const headers = new Headers(options?.headers);
  if (options?.body !== undefined && options.body !== null && !headers.has("content-type")) headers.set("content-type", "application/json");
  // CSRF defense: every state-changing request carries a header that browsers
  // cannot add on cross-site requests. The backend rejects non-GET requests lacking it.
  if (options?.method && options.method !== "GET" && options.method !== "HEAD") headers.set("x-requested-with", "EasyX");
  return headers;
}

export async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...options, credentials: "include", headers: apiHeaders(options) });
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event("easyx:unauthorized"));
    const payload = await response.json().catch(() => ({}));
    throw new Error((payload as { error?: string }).error ?? `Request failed (${response.status})`);
  }
  return (await response.json().catch(() => ({}))) as T;
}
