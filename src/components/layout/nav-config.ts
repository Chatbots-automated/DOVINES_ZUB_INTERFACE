import {
  LayoutDashboard,
  PawPrint,
  Repeat,
  Activity,
  CalendarClock,
  Syringe,
  Dna,
  Droplet,
  Footprints,
  RefreshCw,
  PackagePlus,
  Pill,
  Boxes,
  BarChart3,
  FileMinus,
  ShieldCheck,
  Layers,
  KeyRound,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  minRole?: "vet" | "admin"; // undefined = any active staff
}

export interface NavGroup {
  id: string;
  label: string;
  items: NavItem[];
}

export type ModuleId = "veterinarija" | "apskaita";

// Module 1 — Veterinarija. Only Priedas Nr. 1 modules (§2.3-§2.7, §2.10);
// the integration screens are a separate admin-only group: DelPro (§3-§4)
// and VIC credentials (stored only — requested by the farm, 2026-10).
export const vetNavGroups: NavGroup[] = [
  {
    id: "veterinarija",
    label: "Veterinarija",
    items: [
      { href: "/veterinarija", label: "Pagrindinis", icon: LayoutDashboard },
      { href: "/veterinarija/gyvunai", label: "Gyvūnai", icon: PawPrint },
      { href: "/veterinarija/vizitai", label: "Vizitai", icon: CalendarClock },
      { href: "/veterinarija/gydymo-istorija", label: "Gydymų istorija", icon: Activity },
      { href: "/veterinarija/gydymo-kursai", label: "Gydymo kursai", icon: Repeat },
      { href: "/veterinarija/vakcinacijos", label: "Vakcinacijos", icon: Syringe },
      { href: "/veterinarija/sekinimas", label: "Sėklinimas", icon: Dna },
      { href: "/veterinarija/biocidai", label: "Biocidai", icon: Droplet },
      { href: "/veterinarija/nagos", label: "Nagos", icon: Footprints },
    ],
  },
  {
    id: "integracija",
    label: "Integracija",
    items: [
      { href: "/veterinarija/delpro", label: "DelPro", icon: RefreshCw, minRole: "admin" },
      { href: "/veterinarija/vic", label: "VIC", icon: KeyRound, minRole: "admin" },
    ],
  },
];

// Module 2 — Apskaita: §2.1/§2.2/§2.11 (produktai, pajamavimas + PDF),
// §2.5 atsargos, §2.8 žurnalai, §2.9 nurašymo aktai.
export const apskaitaNavGroups: NavGroup[] = [
  {
    id: "apskaita",
    label: "Apskaita",
    items: [
      { href: "/apskaita", label: "Pagrindinis", icon: LayoutDashboard },
      { href: "/apskaita/pajamavimas", label: "Pajamavimas", icon: PackagePlus },
      { href: "/apskaita/produktai", label: "Produktai", icon: Pill },
      { href: "/apskaita/atsargos", label: "Atsargos", icon: Boxes },
      { href: "/apskaita/ataskaitos", label: "Žurnalai ir ataskaitos", icon: BarChart3 },
      { href: "/apskaita/nurasymo-aktai", label: "Nurašymo aktai", icon: FileMinus },
      { href: "/apskaita/nurasymo-grupes", label: "Nurašymo grupės", icon: Layers, minRole: "admin" },
    ],
  },
  {
    id: "vartotojai",
    label: "Vartotojai",
    items: [{ href: "/apskaita/vartotojai", label: "Vartotojų valdymas", icon: ShieldCheck, minRole: "admin" }],
  },
];

// Per-module colour classes for the dark sidebar chrome: Veterinarija is
// lake teal, Apskaita heather plum. Full class strings so Tailwind sees them.
export const moduleTheme: Record<ModuleId, { badge: string; bar: string; icon: string }> = {
  veterinarija: { badge: "bg-accent", bar: "bg-accent-border", icon: "text-accent-border" },
  apskaita: { badge: "bg-accent-alt", bar: "bg-accent-alt-border", icon: "text-accent-alt-border" },
};
