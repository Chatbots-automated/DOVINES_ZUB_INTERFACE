export const WRITE_OFF_STATUS: Record<string, { label: string; tone: "warning" | "success" | "neutral" }> = {
  draft: { label: "Juodraštis", tone: "warning" },
  approved: { label: "Patvirtintas", tone: "success" },
  cancelled: { label: "Anuliuotas", tone: "neutral" },
};
