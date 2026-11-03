// Browser -> /api/seklinimas/delpro (0053). Any non-JSON answer (login redirect, proxy error) becomes a readable error.
export type DelproInsResult = { ok: true; data: { message?: string; requested?: number } | null } | { ok: false; error: string };

export async function delproInseminationPost(op: "request" | "dismiss_duplicate", payload: Record<string, unknown>): Promise<DelproInsResult> {
  let res: Response;
  try {
    res = await fetch("/api/seklinimas/delpro", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op, ...payload }),
      credentials: "same-origin",
    });
  } catch {
    return { ok: false, error: "Nepavyko susisiekti su serveriu." };
  }
  const json = (await res.json().catch(() => null)) as DelproInsResult | null;
  if (!json || typeof json.ok !== "boolean") {
    return { ok: false, error: res.redirected ? "Sesija baigėsi — prisijunkite iš naujo." : `Serverio klaida (HTTP ${res.status}).` };
  }
  return json;
}
