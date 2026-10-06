import type { Database } from "@/lib/supabase/types";

export type Profile = Database["public"]["Tables"]["users"]["Row"];

const ROLE_LABELS: Record<Profile["role"], string> = {
  admin: "Administratorius",
  vet: "Veterinarijos gydytojas",
  tech: "Zootechnikas",
  viewer: "Stebėtojas",
};

export function roleLabel(role: Profile["role"]) {
  return ROLE_LABELS[role];
}

export const ROLE_OPTIONS: { value: Profile["role"]; label: string }[] = (
  Object.keys(ROLE_LABELS) as Profile["role"][]
).map((value) => ({ value, label: ROLE_LABELS[value] }));
