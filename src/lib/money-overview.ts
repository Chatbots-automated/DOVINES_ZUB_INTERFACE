import { createClient } from "@/lib/supabase/server";
import type { Period } from "@/lib/analytics-period";
import { DRUG_CATEGORIES } from "@/lib/product-categories";
import type { ProductCategory } from "@/lib/supabase/types";

type Client = Awaited<ReturnType<typeof createClient>>;

const isDrug = (category: string) => DRUG_CATEGORIES.includes(category as ProductCategory);

// Money picture for the Pagrindinis pages (0032_analytics.sql): what was
// consumed and bought in the period, and what is on hand. Values are
// quantity × the batch's per-unit purchase price; batches without a price
// count as 0 € (`unpriced`). Aggregated in the database, so not row-capped.
// "Vaistai" = DRUG_CATEGORIES (medicines, vakcina, profilaktika, boliusai).
export async function loadMoneyOverview(supabase: Client, period: Period) {
  const [monthlyRes, categoryRes, topRes, stockRes] = await Promise.all([
    supabase.rpc("analytics_monthly", { p_from: period.from, p_to: period.to }),
    supabase.rpc("analytics_spend_by_category", { p_from: period.from, p_to: period.to }),
    supabase.rpc("analytics_top_products", { p_from: period.from, p_to: period.to, p_limit: 8 }),
    supabase.from("vw_stock_value_by_category").select("*"),
  ]);

  const monthly = monthlyRes.data ?? [];
  const byCategory = categoryRes.data ?? [];
  const top = topRes.data ?? [];
  const stock = [...(stockRes.data ?? [])].sort((a, b) => b.usable_value + b.expired_value - (a.usable_value + a.expired_value));

  const sum = <T,>(rows: T[], pick: (r: T) => number) => rows.reduce((s, r) => s + pick(r), 0);

  return {
    monthly,
    byCategory,
    top,
    stock,
    consumed: sum(monthly, (m) => Number(m.consumed)),
    purchased: sum(monthly, (m) => Number(m.purchased)),
    drugSpent: sum(byCategory.filter((c) => isDrug(c.category)), (c) => Number(c.spent)),
    usableValue: sum(stock, (c) => Number(c.usable_value)),
    drugStockValue: sum(stock.filter((c) => isDrug(c.category)), (c) => Number(c.usable_value)),
    expiredValue: sum(stock, (c) => Number(c.expired_value)),
    expiredBatches: sum(stock, (c) => Number(c.expired_batches)),
    unpriced: sum(stock, (c) => Number(c.unpriced_batches)),
  };
}

export type MoneyOverview = Awaited<ReturnType<typeof loadMoneyOverview>>;
