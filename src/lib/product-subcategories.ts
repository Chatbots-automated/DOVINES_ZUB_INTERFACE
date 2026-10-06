import type { ProductCategory } from "@/lib/supabase/types";

export type SubcategoryOption = { id: string; category: ProductCategory; name: string; active: boolean };
