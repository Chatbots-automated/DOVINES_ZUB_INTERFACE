// Browser -> /api/cms (src/app/api/cms/route.ts). Any non-JSON answer (login redirect, proxy error) becomes a readable error.
export type CmsResult<T = unknown> = { ok: true; data: T } | { ok: false; error: string; details?: unknown };

export async function cmsPost<T = unknown>(op: string, payload: Record<string, unknown> = {}): Promise<CmsResult<T>> {
  let res: Response;
  try {
    res = await fetch("/api/cms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op, ...payload }),
      credentials: "same-origin",
    });
  } catch {
    return { ok: false, error: "Nepavyko susisiekti su serveriu." };
  }
  const json = (await res.json().catch(() => null)) as CmsResult<T> | null;
  if (!json || typeof json.ok !== "boolean") {
    return { ok: false, error: res.redirected ? "Sesija baigėsi — prisijunkite iš naujo." : `Serverio klaida (HTTP ${res.status}).` };
  }
  return json;
}

export type CmsSearchAnimal = {
  id: string;
  tag_no: string;
  animal_no: string | null;
  name: string | null;
  group_name: string | null;
  delpro_object_guid: string | null;
  live_action_key: string | null;
  open_job_status: string | null;
};

export type CmsSearchResult = { ok: true; count: number; page: number; pageSize: number; truncated: boolean; animals: CmsSearchAnimal[] };

export async function cmsSearch(params: { q?: string; group?: string; delpro?: string; page?: number; all?: boolean }): Promise<CmsSearchResult | { ok: false; error: string }> {
  const sp = new URLSearchParams();
  if (params.q) sp.set("q", params.q);
  if (params.group) sp.set("group", params.group);
  if (params.delpro) sp.set("delpro", params.delpro);
  if (params.page) sp.set("page", String(params.page));
  if (params.all) sp.set("all", "1");
  try {
    const res = await fetch(`/api/cms?${sp.toString()}`, { credentials: "same-origin" });
    const json = await res.json().catch(() => null);
    if (!json || typeof json.ok !== "boolean") return { ok: false, error: `Serverio klaida (HTTP ${res.status}).` };
    return json;
  } catch {
    return { ok: false, error: "Nepavyko susisiekti su serveriu." };
  }
}
