-- 0023_product_subcategories.sql
-- Product subcategories (e.g. Nagų priežiūra -> Paduka / Tvarsčiai /
-- Vonios-dezinfekcija) + products.standard_amount (quantity prefilled when a
-- hoof product is picked in Nagų apžiūra). hoof_care itself is added in 0022.

create table product_subcategories (
  id uuid primary key default gen_random_uuid(),
  category product_category not null,
  name text not null check (length(btrim(name)) > 0),
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create unique index product_subcategories_category_name_key on product_subcategories (category, lower(name));

alter table products
  add column subcategory_id uuid references product_subcategories (id) on delete set null,
  add column standard_amount numeric check (standard_amount is null or standard_amount > 0);

create index products_subcategory_idx on products (subcategory_id) where subcategory_id is not null;

alter table product_subcategories enable row level security;
create policy product_subcategories_select on product_subcategories for select using (fn_is_authenticated_active());
create policy product_subcategories_insert on product_subcategories for insert with check (fn_is_active_staff());
create policy product_subcategories_update on product_subcategories for update using (fn_is_active_staff());
create policy product_subcategories_delete on product_subcategories for delete using (fn_is_active_staff());

insert into product_subcategories (category, name, sort_order) values
  ('hoof_care', 'Paduka', 1),
  ('hoof_care', 'Tvarsčiai', 2),
  ('hoof_care', 'Vonios / dezinfekcija', 3);

-- hoof_care products land on the "Medžiagos, MGSD" act by default (like
-- treatment_materials); reproduction (0017) keeps falling through to vaistai.
create or replace function fn_product_write_off_kind(p_category product_category, p_kind text)
returns text
language sql
immutable
as $$
  select coalesce(p_kind, case p_category::text
    when 'treatment_materials' then 'medziagos'
    when 'hoof_care' then 'medziagos'
    when 'priedas' then 'priedai'
    else 'vaistai'
  end);
$$;
