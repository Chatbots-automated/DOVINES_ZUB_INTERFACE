import { redirect } from "next/navigation";

// Apskaita has no separate "Pagrindinis" tab in the requested nav — the
// module opens straight on its first tab (Pajamavimas).
export default function ApskaitaIndexPage() {
  redirect("/apskaita/pajamavimas");
}
