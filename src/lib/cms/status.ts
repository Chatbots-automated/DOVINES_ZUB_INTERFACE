import type { CmsJobStatus } from "@/lib/supabase/types";

// CMS atskyrimų būsenos (0048). "Patvirtinta" is NOT "done": only the farm-PC worker's verified read-back sets success.
export type CmsTone = "neutral" | "info" | "success" | "danger" | "warning" | "accent";

export const CMS_STATUS_LABEL: Record<CmsJobStatus, string> = {
  draft: "Juodraštis",
  pending_approval: "Laukia patvirtinimo",
  approved: "Patvirtinta · laukia perdavimo",
  processing: "Perduodama",
  success: "Perduota į DelPro",
  error: "Klaida",
  needs_review: "Reikia peržiūros",
  cancelled: "Atšaukta",
  skipped: "Praleista",
};

export const CMS_STATUS_TONE: Record<CmsJobStatus, CmsTone> = {
  draft: "neutral",
  pending_approval: "warning",
  approved: "info",
  processing: "info",
  success: "success",
  error: "danger",
  needs_review: "danger",
  cancelled: "neutral",
  skipped: "neutral",
};

export const CMS_OPEN_STATUSES: CmsJobStatus[] = ["pending_approval", "approved", "processing", "needs_review"];

export const CMS_APPROVAL_WARNING = "Šie nustatymai gali valdyti fizinį gyvulių atskyrimą per DelPro CMS.";
