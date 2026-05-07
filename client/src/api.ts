export async function fetchJson<T>(url: string, opts?: RequestInit): Promise<T> {
  const r = await fetch(url, opts);
  const text = await r.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!r.ok) {
    const err =
      typeof data === "object" && data !== null && "error" in data && typeof (data as { error: unknown }).error === "string"
        ? (data as { error: string }).error
        : r.statusText || "Request failed";
    throw new Error(err);
  }
  return data as T;
}

export function simStateUrl(useFixture: boolean): string {
  return useFixture ? "/api/sim-state?fixture=1" : "/api/sim-state";
}
