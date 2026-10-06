import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatEur(value: number | null | undefined) {
  const amount = value ?? 0;
  return new Intl.NumberFormat("lt-LT", { style: "currency", currency: "EUR" }).format(amount);
}

export function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("lt-LT", { dateStyle: "medium" }).format(new Date(value));
}

export function formatDateTime(value: string | null | undefined) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("lt-LT", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function formatQty(value: number | null | undefined, unit?: string | null) {
  if (value === null || value === undefined) return "—";
  const formatted = new Intl.NumberFormat("lt-LT", { maximumFractionDigits: 3 }).format(value);
  return unit ? `${formatted} ${unit}` : formatted;
}
