// Hand-written to match supabase/migrations/*.sql. Keep in sync manually,
// or regenerate later with `supabase gen types typescript` once the
// Supabase CLI is linked to the project.

export type UserRole = "admin" | "vet" | "tech" | "viewer";
export type ProductCategory =
  | "medicines"
  | "vakcina"
  | "biocide"
  | "priedas"
  | "reproduction"
  | "hoof_care"
  | "treatment_materials"
  | "other";
export type Unit = "ml" | "l" | "g" | "kg" | "pcs" | "vnt" | "tablet" | "dose";
export type AdministrationRoute = "iv" | "im" | "sc" | "iu" | "imm" | "pos" | "kita";
export type BatchStatus = "active" | "depleted" | "expired";
export type CourseStatus = "active" | "completed" | "cancelled";
// delpro_sync_jobs.status (text + check constraint, 0006_delpro_integration.sql)
export type DelproSyncJobStatus =
  | "pending_approval"
  | "approved"
  | "rejected"
  | "processing"
  | "success"
  | "error"
  | "verification_failed";
export type DelproOutboundMode = "approval" | "auto" | "off";
// `treatments.procedure_type` — only "gydymas" is enqueued for DelPro.
export type ProcedureType = "apziura" | "gydymas" | "profilaktika";
// animal_visits (0018_visits.sql) — text + check constraints.
export type VisitProcedure = "temperatura" | "apziura" | "profilaktika" | "gydymas" | "vakcina" | "kita";
export type VisitStatus = "planuojamas" | "vykdomas" | "baigtas" | "atsauktas" | "neivykes";
export type WriteOffActStatus = "draft" | "approved" | "cancelled";
// Farm's three act templates (0012_write_off_templates.sql).
export type HoofLeg = "FL" | "FR" | "HL" | "HR";
export type HoofClaw = "inner" | "outer";
export type HoofZoneSelection = { zone: number; claw: HoofClaw };
export type WriteOffKind = "vaistai" | "priedai" | "medziagos";
export type WriteOffGroupRuleField = "delpro_group" | "animal_sex";
export type WriteOffSignatory = { title: string; name: string };

type Row<T> = T;
type Insertable<T, Required extends keyof T> = Partial<T> & Pick<T, Required>;
type Updatable<T> = Partial<T>;

export interface Database {
  public: {
    Tables: {
      users: {
        Row: Row<{
          id: string;
          email: string;
          full_name: string | null;
          role: UserRole;
          is_frozen: boolean;
          last_login: string | null;
          created_at: string;
          updated_at: string;
        }>;
        Insert: Insertable<Database["public"]["Tables"]["users"]["Row"], "id" | "email">;
        Update: Updatable<Database["public"]["Tables"]["users"]["Row"]>;
        Relationships: [];
      };

      system_settings: {
        Row: Row<{ setting_key: string; setting_value: string | null; description: string | null; updated_at: string }>;
        Insert: Insertable<Database["public"]["Tables"]["system_settings"]["Row"], "setting_key">;
        Update: Updatable<Database["public"]["Tables"]["system_settings"]["Row"]>;
        Relationships: [];
      };

      diseases: {
        Row: Row<{ id: string; code: string | null; name: string; created_at: string }>;
        Insert: Insertable<Database["public"]["Tables"]["diseases"]["Row"], "name">;
        Update: Updatable<Database["public"]["Tables"]["diseases"]["Row"]>;
        Relationships: [];
      };

      animals: {
        Row: Row<{
          id: string;
          tag_no: string;
          animal_no: string | null;
          delpro_animal_id: string | null;
          name: string | null;
          species: string;
          sex: string | null;
          breed: string | null;
          birth_date: string | null;
          group_id: string | null;
          group_name: string | null;
          lactation_no: number | null;
          active: boolean;
          source: "manual" | "delpro" | "vic";
          updated_from_delpro_at: string | null;
          updated_from_vic_at: string | null;
          // DairyPlan-style fields fed by DelPro (0020_animal_delpro_fields.sql)
          reproduction_status: string | null;
          last_calving_date: string | null;
          days_in_milk: number | null;
          milk_yield_kg: number | null;
          last_milking_at: string | null;
          last_milking_kg: number | null;
          produces_milk: boolean | null;
          last_insemination_date: string | null;
          insemination_count: number | null;
          last_bulls: string | null;
          is_pregnant: boolean | null;
          pregnancy_days: number | null;
          expected_calving_date: string | null;
          dry_off_date: string | null;
          genetic_worth: string | null;
          blood_line: string | null;
          missing_teats: string[] | null;
          health_alert: string | null;
          group_since: string | null;
          notes: string | null;
          created_at: string;
          updated_at: string;
        }>;
        Insert: Insertable<Database["public"]["Tables"]["animals"]["Row"], "tag_no">;
        Update: Updatable<Database["public"]["Tables"]["animals"]["Row"]>;
        Relationships: [];
      };

      delpro_groups: {
        Row: Row<{
          id: string;
          delpro_group_id: string | null;
          name: string;
          active: boolean;
          updated_from_delpro_at: string | null;
          created_at: string;
          updated_at: string;
        }>;
        Insert: Insertable<Database["public"]["Tables"]["delpro_groups"]["Row"], "name">;
        Update: Updatable<Database["public"]["Tables"]["delpro_groups"]["Row"]>;
        Relationships: [];
      };

      suppliers: {
        Row: Row<{
          id: string;
          name: string;
          code: string | null;
          vat_code: string | null;
          phone: string | null;
          email: string | null;
          created_at: string;
        }>;
        Insert: Insertable<Database["public"]["Tables"]["suppliers"]["Row"], "name">;
        Update: Updatable<Database["public"]["Tables"]["suppliers"]["Row"]>;
        Relationships: [];
      };

      products: {
        Row: Row<{
          id: string;
          name: string;
          category: ProductCategory;
          is_antimicrobial: boolean;
          unit: Unit;
          active_substance: string | null;
          registration_code: string | null;
          dosage_notes: string | null;
          package_weight_g: number | null;
          min_stock_alert: number | null;
          withdrawal_days_milk: number;
          withdrawal_days_meat: number;
          withdrawal_iv_milk: number | null;
          withdrawal_iv_meat: number | null;
          withdrawal_im_milk: number | null;
          withdrawal_im_meat: number | null;
          withdrawal_sc_milk: number | null;
          withdrawal_sc_meat: number | null;
          withdrawal_iu_milk: number | null;
          withdrawal_iu_meat: number | null;
          withdrawal_imm_milk: number | null;
          withdrawal_imm_meat: number | null;
          withdrawal_pos_milk: number | null;
          withdrawal_pos_meat: number | null;
          write_off_kind: WriteOffKind | null;
          nomenclature_no: string | null;
          act_unit: string | null;
          act_unit_size: number | null;
          default_write_off_group_id: string | null;
          pack_size: number | null;
          subcategory_id: string | null;
          standard_amount: number | null;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        }>;
        Insert: Insertable<Database["public"]["Tables"]["products"]["Row"], "name">;
        Update: Updatable<Database["public"]["Tables"]["products"]["Row"]>;
        Relationships: [];
      };

      invoices: {
        Row: Row<{
          id: string;
          invoice_number: string | null;
          invoice_date: string | null;
          supplier_id: string | null;
          supplier_name: string | null;
          total_net: number | null;
          total_vat: number | null;
          total_gross: number | null;
          currency: string;
          pdf_filename: string | null;
          raw_parsed: Record<string, unknown> | null;
          created_by: string | null;
          created_at: string;
        }>;
        Insert: Insertable<Database["public"]["Tables"]["invoices"]["Row"], never>;
        Update: Updatable<Database["public"]["Tables"]["invoices"]["Row"]>;
        Relationships: [];
      };

      invoice_items: {
        Row: Row<{
          id: string;
          invoice_id: string;
          product_id: string | null;
          batch_id: string | null;
          line_no: number | null;
          description: string | null;
          sku: string | null;
          quantity: number | null;
          unit_price: number | null;
          total_price: number | null;
        }>;
        Insert: Insertable<Database["public"]["Tables"]["invoice_items"]["Row"], "invoice_id">;
        Update: Updatable<Database["public"]["Tables"]["invoice_items"]["Row"]>;
        Relationships: [];
      };

      batches: {
        Row: Row<{
          id: string;
          product_id: string;
          supplier_id: string | null;
          invoice_id: string | null;
          lot: string | null;
          mfg_date: string | null;
          expiry_date: string | null;
          received_qty: number;
          qty_left: number;
          package_size: number | null;
          package_count: number | null;
          purchase_price: number | null;
          currency: string;
          status: BatchStatus;
          received_at: string;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        }>;
        Insert: Insertable<Database["public"]["Tables"]["batches"]["Row"], "product_id" | "received_qty">;
        Update: Updatable<Database["public"]["Tables"]["batches"]["Row"]>;
        Relationships: [];
      };

      treatments: {
        Row: Row<{
          id: string;
          animal_id: string;
          disease_id: string | null;
          reg_date: string;
          diagnosis: string | null;
          administration_route: AdministrationRoute | null;
          outcome: string | null;
          outcome_date: string | null;
          vet_name: string | null;
          notes: string | null;
          procedure_type: ProcedureType;
          animal_group_snapshot: string | null;
          visit_id: string | null;
          withdrawal_until_milk: string | null;
          withdrawal_until_meat: string | null;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        }>;
        Insert: Insertable<Database["public"]["Tables"]["treatments"]["Row"], "animal_id">;
        Update: Updatable<Database["public"]["Tables"]["treatments"]["Row"]>;
        Relationships: [];
      };

      treatment_courses: {
        Row: Row<{
          id: string;
          treatment_id: string;
          days: number;
          administration_route: AdministrationRoute | null;
          start_date: string;
          status: CourseStatus;
          notes: string | null;
          created_at: string;
          updated_at: string;
        }>;
        Insert: Insertable<Database["public"]["Tables"]["treatment_courses"]["Row"], "treatment_id" | "days">;
        Update: Updatable<Database["public"]["Tables"]["treatment_courses"]["Row"]>;
        Relationships: [];
      };

      course_doses: {
        Row: Row<{
          id: string;
          course_id: string;
          day_number: number;
          scheduled_date: string;
          product_id: string | null;
          batch_id: string | null;
          dose_amount: number | null;
          unit: Unit | null;
          administration_route: AdministrationRoute | null;
          administered: boolean;
          administered_date: string | null;
          administered_by: string | null;
          notes: string | null;
          created_at: string;
        }>;
        Insert: Insertable<Database["public"]["Tables"]["course_doses"]["Row"], "course_id" | "day_number" | "scheduled_date">;
        Update: Updatable<Database["public"]["Tables"]["course_doses"]["Row"]>;
        Relationships: [];
      };

      vaccinations: {
        Row: Row<{
          id: string;
          session_id: string | null;
          target_group_name: string | null;
          animal_id: string;
          product_id: string;
          batch_id: string | null;
          vaccination_date: string;
          dose_amount: number | null;
          unit: Unit | null;
          administration_route: AdministrationRoute | null;
          is_revaccination: boolean;
          next_booster_date: string | null;
          administered_by: string | null;
          vet_name: string | null;
          notes: string | null;
          animal_group_snapshot: string | null;
          visit_id: string | null;
          withdrawal_until_milk: string | null;
          withdrawal_until_meat: string | null;
          created_at: string;
        }>;
        Insert: Insertable<Database["public"]["Tables"]["vaccinations"]["Row"], "animal_id" | "product_id">;
        Update: Updatable<Database["public"]["Tables"]["vaccinations"]["Row"]>;
        Relationships: [];
      };

      animal_visits: {
        Row: Row<{
          id: string;
          animal_id: string;
          visit_datetime: string;
          procedures: VisitProcedure[];
          temperature: number | null;
          temperature_measured_at: string | null;
          status: VisitStatus;
          notes: string | null;
          vet_name: string | null;
          next_visit_required: boolean;
          next_visit_date: string | null;
          related_visit_id: string | null;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        }>;
        Insert: Insertable<Database["public"]["Tables"]["animal_visits"]["Row"], "animal_id">;
        Update: Updatable<Database["public"]["Tables"]["animal_visits"]["Row"]>;
        Relationships: [];
      };

      biocide_usage: {
        Row: Row<{
          id: string;
          product_id: string;
          batch_id: string | null;
          use_date: string;
          purpose: string | null;
          work_scope: string | null;
          qty: number | null;
          unit: Unit | null;
          used_by_name: string | null;
          created_at: string;
        }>;
        Insert: Insertable<Database["public"]["Tables"]["biocide_usage"]["Row"], "product_id">;
        Update: Updatable<Database["public"]["Tables"]["biocide_usage"]["Row"]>;
        Relationships: [];
      };

      general_usage: {
        Row: Row<{
          id: string;
          product_id: string;
          batch_id: string | null;
          use_date: string;
          qty: number;
          unit: Unit | null;
          stock_before: number | null;
          counted_remaining: number | null;
          write_off_group_id: string | null;
          notes: string | null;
          created_by: string | null;
          created_at: string;
        }>;
        Insert: Insertable<Database["public"]["Tables"]["general_usage"]["Row"], "product_id" | "qty">;
        Update: Updatable<Database["public"]["Tables"]["general_usage"]["Row"]>;
        Relationships: [];
      };

      insemination_records: {
        Row: Row<{
          id: string;
          animal_id: string;
          insemination_date: string;
          sperm_product_id: string | null;
          sperm_quantity: number | null;
          glove_product_id: string | null;
          glove_quantity: number | null;
          pazymejimo_nr: string | null;
          seklintojo_kodas: string | null;
          inseminator_name: string | null;
          karves_id: string | null;
          imones_kodas: string | null;
          bull_name: string | null;
          reproduktoriaus_id: string | null;
          reproduktoriaus_kk_kodas: string | null;
          sp_savininkas: string | null;
          pregnancy_confirmed: boolean | null;
          pregnancy_check_date: string | null;
          next_pregnancy_check_date: string | null;
          pregnancy_notes: string | null;
          notes: string | null;
          animal_group_snapshot: string | null;
          performed_by: string | null;
          created_at: string;
          updated_at: string;
        }>;
        Insert: Insertable<Database["public"]["Tables"]["insemination_records"]["Row"], "animal_id">;
        Update: Updatable<Database["public"]["Tables"]["insemination_records"]["Row"]>;
        Relationships: [
          { foreignKeyName: "insemination_records_animal_id_fkey"; columns: ["animal_id"]; isOneToOne: false; referencedRelation: "animals"; referencedColumns: ["id"] },
          { foreignKeyName: "insemination_records_sperm_product_id_fkey"; columns: ["sperm_product_id"]; isOneToOne: false; referencedRelation: "products"; referencedColumns: ["id"] },
          { foreignKeyName: "insemination_records_glove_product_id_fkey"; columns: ["glove_product_id"]; isOneToOne: false; referencedRelation: "products"; referencedColumns: ["id"] },
        ];
      };

      hoof_condition_codes: {
        Row: Row<{ code: string; description: string; severity_default: number; sort_order: number }>;
        Insert: Insertable<Database["public"]["Tables"]["hoof_condition_codes"]["Row"], "code" | "description">;
        Update: Updatable<Database["public"]["Tables"]["hoof_condition_codes"]["Row"]>;
        Relationships: [];
      };

      hoof_exams: {
        Row: Row<{
          id: string;
          animal_id: string;
          exam_date: string;
          performed_by: string | null;
          notes: string | null;
          animal_group_snapshot: string | null;
          created_by: string | null;
          created_at: string;
        }>;
        Insert: Insertable<Database["public"]["Tables"]["hoof_exams"]["Row"], "animal_id">;
        Update: Updatable<Database["public"]["Tables"]["hoof_exams"]["Row"]>;
        Relationships: [
          { foreignKeyName: "hoof_exams_animal_id_fkey"; columns: ["animal_id"]; isOneToOne: false; referencedRelation: "animals"; referencedColumns: ["id"] },
        ];
      };

      hoof_findings: {
        Row: Row<{
          id: string;
          exam_id: string;
          leg: HoofLeg | null;
          zones: HoofZoneSelection[];
          condition_code: string | null;
          diagnosis: string | null;
          severity: number;
          was_trimmed: boolean;
          was_treated: boolean;
          bandage_applied: boolean;
          followup_required: boolean;
          followup_date: string | null;
          followup_completed: boolean;
          notes: string | null;
          created_at: string;
        }>;
        Insert: Insertable<Database["public"]["Tables"]["hoof_findings"]["Row"], "exam_id">;
        Update: Updatable<Database["public"]["Tables"]["hoof_findings"]["Row"]>;
        Relationships: [
          { foreignKeyName: "hoof_findings_exam_id_fkey"; columns: ["exam_id"]; isOneToOne: false; referencedRelation: "hoof_exams"; referencedColumns: ["id"] },
          { foreignKeyName: "hoof_findings_condition_code_fkey"; columns: ["condition_code"]; isOneToOne: false; referencedRelation: "hoof_condition_codes"; referencedColumns: ["code"] },
        ];
      };

      usage_items: {
        Row: Row<{
          id: string;
          product_id: string;
          batch_id: string;
          qty: number;
          unit: Unit | null;
          administration_route: AdministrationRoute | null;
          treatment_id: string | null;
          course_dose_id: string | null;
          vaccination_id: string | null;
          biocide_usage_id: string | null;
          general_usage_id: string | null;
          insemination_id: string | null;
          hoof_finding_id: string | null;
          created_at: string;
        }>;
        Insert: Insertable<Database["public"]["Tables"]["usage_items"]["Row"], "product_id" | "batch_id" | "qty">;
        Update: Updatable<Database["public"]["Tables"]["usage_items"]["Row"]>;
        Relationships: [];
      };

      medical_waste: {
        Row: Row<{
          id: string;
          waste_code: string | null;
          name: string | null;
          waste_date: string;
          qty_generated: number | null;
          qty_transferred: number | null;
          carrier: string | null;
          processor: string | null;
          transfer_date: string | null;
          doc_no: string | null;
          responsible: string | null;
          auto_generated: boolean;
          source_batch_id: string | null;
          created_at: string;
        }>;
        Insert: Insertable<Database["public"]["Tables"]["medical_waste"]["Row"], never>;
        Update: Updatable<Database["public"]["Tables"]["medical_waste"]["Row"]>;
        Relationships: [];
      };

      delpro_sync_runs: {
        Row: Row<{
          id: string;
          kind: "animals";
          worker_id: string | null;
          received_rows: number;
          inserted: number;
          updated: number;
          deactivated: number;
          groups_received: number;
          skipped: number;
          error: string | null;
          created_at: string;
        }>;
        Insert: Insertable<Database["public"]["Tables"]["delpro_sync_runs"]["Row"], never>;
        Update: Updatable<Database["public"]["Tables"]["delpro_sync_runs"]["Row"]>;
        Relationships: [];
      };

      delpro_mappings: {
        Row: Row<{
          id: string;
          kind: "disease" | "product";
          local_id: string;
          delpro_code: string | null;
          delpro_name: string | null;
          notes: string | null;
          created_at: string;
          updated_at: string;
        }>;
        Insert: Insertable<Database["public"]["Tables"]["delpro_mappings"]["Row"], "kind" | "local_id">;
        Update: Updatable<Database["public"]["Tables"]["delpro_mappings"]["Row"]>;
        Relationships: [];
      };

      delpro_sync_jobs: {
        Row: Row<DelproSyncJobRow>;
        Insert: Insertable<DelproSyncJobRow, "treatment_id">;
        Update: Updatable<DelproSyncJobRow>;
        Relationships: [];
      };

      vic_sync_runs: {
        Row: Row<{
          id: string;
          received_rows: number;
          inserted: number;
          enriched: number;
          unchanged: number;
          deactivated: number;
          skipped: number;
          created_at: string;
        }>;
        Insert: Insertable<Database["public"]["Tables"]["vic_sync_runs"]["Row"], never>;
        Update: Updatable<Database["public"]["Tables"]["vic_sync_runs"]["Row"]>;
        Relationships: [];
      };

      write_off_purposes: {
        Row: Row<{ id: string; name: string; sort_order: number; active: boolean; created_at: string }>;
        Insert: Insertable<Database["public"]["Tables"]["write_off_purposes"]["Row"], "name">;
        Update: Updatable<Database["public"]["Tables"]["write_off_purposes"]["Row"]>;
        Relationships: [];
      };

      product_subcategories: {
        Row: Row<{ id: string; category: ProductCategory; name: string; sort_order: number; active: boolean; created_at: string }>;
        Insert: Insertable<Database["public"]["Tables"]["product_subcategories"]["Row"], "category" | "name">;
        Update: Updatable<Database["public"]["Tables"]["product_subcategories"]["Row"]>;
        Relationships: [];
      };

      write_off_groups: {
        Row: Row<{ id: string; name: string; act_kinds: WriteOffKind[]; sort_order: number; active: boolean; created_at: string }>;
        Insert: Insertable<Database["public"]["Tables"]["write_off_groups"]["Row"], "name" | "act_kinds">;
        Update: Updatable<Database["public"]["Tables"]["write_off_groups"]["Row"]>;
        Relationships: [];
      };

      write_off_group_rules: {
        Row: Row<{
          id: string;
          write_off_group_id: string;
          match_field: WriteOffGroupRuleField;
          match_value: string;
          created_at: string;
        }>;
        Insert: Insertable<
          Database["public"]["Tables"]["write_off_group_rules"]["Row"],
          "write_off_group_id" | "match_field" | "match_value"
        >;
        Update: Updatable<Database["public"]["Tables"]["write_off_group_rules"]["Row"]>;
        Relationships: [];
      };

      write_off_acts: {
        Row: Row<{
          id: string;
          act_number: string;
          act_date: string;
          period_start: string;
          period_end: string;
          product_category: ProductCategory | null;
          status: WriteOffActStatus;
          commission: string | null;
          notes: string | null;
          total_amount: number;
          created_by: string | null;
          approved_by: string | null;
          approved_at: string | null;
          cancelled_by: string | null;
          cancelled_at: string | null;
          act_kind: WriteOffKind;
          account_no: string | null;
          expense_object: string | null;
          approver_title: string | null;
          approver_name: string | null;
          signatories: WriteOffSignatory[];
          created_at: string;
          updated_at: string;
        }>;
        Insert: Insertable<Database["public"]["Tables"]["write_off_acts"]["Row"], "act_number" | "period_start" | "period_end">;
        Update: Updatable<Database["public"]["Tables"]["write_off_acts"]["Row"]>;
        Relationships: [];
      };

      write_off_act_items: {
        Row: Row<{
          id: string;
          act_id: string;
          line_no: number;
          product_id: string | null;
          product_name: string;
          product_category: ProductCategory | null;
          registration_code: string | null;
          lots: string | null;
          unit: Unit | null;
          quantity: number;
          unit_price: number;
          total_price: number;
          notes: string | null;
          nomenclature_no: string | null;
          unit_label: string | null;
        }>;
        Insert: Insertable<Database["public"]["Tables"]["write_off_act_items"]["Row"], "act_id" | "line_no" | "product_name" | "quantity">;
        Update: Updatable<Database["public"]["Tables"]["write_off_act_items"]["Row"]>;
        Relationships: [];
      };

      write_off_act_allocations: {
        Row: Row<{
          id: string;
          item_id: string;
          label: string;
          quantity: number;
          animal_count: number | null;
          suggested: boolean;
          notes: string | null;
          write_off_group_id: string | null;
        }>;
        Insert: Insertable<Database["public"]["Tables"]["write_off_act_allocations"]["Row"], "item_id" | "label" | "quantity">;
        Update: Updatable<Database["public"]["Tables"]["write_off_act_allocations"]["Row"]>;
        Relationships: [];
      };

      user_audit_logs: {
        Row: Row<{
          id: string;
          user_id: string | null;
          action: string;
          table_name: string | null;
          record_id: string | null;
          old_data: Record<string, unknown> | null;
          new_data: Record<string, unknown> | null;
          created_at: string;
        }>;
        Insert: Insertable<Database["public"]["Tables"]["user_audit_logs"]["Row"], "action">;
        Update: Updatable<Database["public"]["Tables"]["user_audit_logs"]["Row"]>;
        Relationships: [];
      };
    };

    Views: {
      stock_by_batch: {
        Row: Row<{
          id: string;
          product_id: string;
          product_name: string;
          unit: Unit;
          lot: string | null;
          qty_left: number;
          expiry_date: string | null;
        }>;
        Relationships: [];
      };
      stock_by_product: {
        Row: Row<{
          product_id: string;
          product_name: string;
          unit: Unit;
          min_stock_alert: number | null;
          qty_left: number;
        }>;
        Relationships: [];
      };
      vw_withdrawal_status: {
        Row: Row<{
          animal_id: string;
          tag_no: string;
          milk_until: string | null;
          meat_until: string | null;
          milk_active: boolean;
          meat_active: boolean;
        }>;
        Relationships: [];
      };
      vw_usage_items_detailed: {
        Row: Row<{
          usage_item_id: string;
          product_id: string;
          batch_id: string;
          qty: number;
          unit: Unit | null;
          administration_route: AdministrationRoute | null;
          purchase_price: number | null;
          lot: string | null;
          source_kind: "treatment" | "course_dose" | "vaccination" | "biocide" | "general" | "hoof" | "insemination";
          used_on: string;
          animal_id: string | null;
          animal_group: string | null;
          biocide_purpose: string | null;
          treatment_id: string | null;
          vaccination_id: string | null;
          biocide_usage_id: string | null;
          general_usage_id: string | null;
          general_write_off_group_id: string | null;
          animal_sex: string | null;
          insemination_id: string | null;
          hoof_finding_id: string | null;
          hoof_exam_id: string | null;
        }>;
        Relationships: [];
      };
      vw_vet_drug_journal: {
        Row: Row<{
          batch_id: string;
          product_id: string;
          product_name: string;
          category: ProductCategory;
          registration_code: string | null;
          active_substance: string | null;
          unit: Unit;
          receipt_date: string | null;
          supplier_name: string | null;
          invoice_number: string | null;
          invoice_date: string | null;
          received_qty: number;
          expiry_date: string | null;
          batch_number: string | null;
          quantity_used: number;
          quantity_remaining: number;
        }>;
        Relationships: [];
      };
      vw_treated_animals: {
        Row: Row<{
          treatment_id: string;
          reg_date: string;
          used_on: string;
          animal_id: string;
          tag_no: string;
          animal_no: string | null;
          species: string;
          sex: string | null;
          breed: string | null;
          birth_date: string | null;
          animal_group: string | null;
          disease_name: string | null;
          diagnosis: string | null;
          administration_route: AdministrationRoute | null;
          product_name: string | null;
          batch_number: string | null;
          qty: number | null;
          unit: Unit | null;
          withdrawal_until_meat: string | null;
          withdrawal_until_milk: string | null;
          outcome: string | null;
          outcome_date: string | null;
          vet_name: string | null;
        }>;
        Relationships: [];
      };
      vw_treated_animals_summary: {
        Row: Row<{
          treatment_id: string;
          reg_date: string;
          animal_id: string;
          tag_no: string;
          animal_no: string | null;
          species: string;
          sex: string | null;
          breed: string | null;
          animal_group: string | null;
          disease_name: string | null;
          diagnosis: string | null;
          outcome: string | null;
          outcome_date: string | null;
          withdrawal_until_milk: string | null;
          withdrawal_until_meat: string | null;
          vet_name: string | null;
          products_used: string | null;
          course_days: number | null;
        }>;
        Relationships: [];
      };
      vw_biocide_journal: {
        Row: Row<{
          id: string;
          name: string;
          registration_code: string | null;
          active_substance: string | null;
          unit: Unit;
          use_date: string;
          purpose: string | null;
          work_scope: string | null;
          qty: number | null;
          used_by_name: string | null;
          batch_number: string | null;
          expiry_date: string | null;
        }>;
        Relationships: [];
      };
      vw_medical_waste: {
        Row: Database["public"]["Tables"]["medical_waste"]["Row"];
        Relationships: [];
      };
      vw_antimicrobial_usage: {
        Row: Row<{
          used_on: string;
          source_kind: string;
          product_id: string;
          name: string;
          active_substance: string | null;
          qty: number;
          unit: Unit | null;
          administration_route: AdministrationRoute | null;
          tag_no: string | null;
          animal_no: string | null;
          animal_group: string | null;
          diagnosis: string | null;
          vet_name: string | null;
        }>;
        Relationships: [];
      };
      vw_delpro_sync_jobs: {
        Row: Row<
          DelproSyncJobRow & {
            preview_payload: DelproPayload | null;
            tag_no: string;
            animal_no: string | null;
            reg_date: string;
            diagnosis: string | null;
          }
        >;
        Relationships: [];
      };
      vw_biocide_receiving_journal: {
        Row: Row<{
          id: string;
          name: string;
          registration_code: string | null;
          active_substance: string | null;
          unit: Unit;
          receipt_date: string;
          supplier_name: string | null;
          invoice_number: string | null;
          received_qty: number;
          batch_number: string | null;
          expiry_date: string | null;
          quantity_remaining: number;
        }>;
        Relationships: [];
      };
      vw_write_off_allocation_targets: {
        Row: Row<{ id: string; label: string; act_kinds: WriteOffKind[]; sort_order: number }>;
        Relationships: [];
      };
    };

    Functions: {
      create_treatment: { Args: { p_data: Record<string, unknown> }; Returns: string };
      administer_course_dose: { Args: { p_dose_id: string; p_date?: string }; Returns: undefined };
      create_vaccinations: { Args: { p_data: Record<string, unknown> }; Returns: number };
      create_hoof_exam: { Args: { p_data: Record<string, unknown> }; Returns: string };
      create_insemination: { Args: { p_data: Record<string, unknown> }; Returns: string };
      generate_pazymejimo_nr: { Args: { p_vet_code: string }; Returns: string };
      create_biocide_usage: { Args: { p_data: Record<string, unknown> }; Returns: string };
      create_visit: { Args: { p_data: Record<string, unknown> }; Returns: string };
      create_treatment_for_visit: { Args: { p_visit_id: string; p_data: Record<string, unknown> }; Returns: string };
      create_vaccination_for_visit: { Args: { p_visit_id: string; p_data: Record<string, unknown> }; Returns: number };
      receive_invoice: { Args: { p_data: Record<string, unknown> }; Returns: { invoice_id: string | null; batches: number; total: number } };
      delete_invoice: { Args: { p_invoice_id: string }; Returns: undefined };
      create_general_usage: { Args: { p_data: Record<string, unknown> }; Returns: number };
      vic_get_settings: {
        Args: Record<string, never>;
        Returns: {
          vic_username: string;
          vic_farm_code: string | null;
          password_set: boolean;
          is_active: boolean;
          updated_at: string;
          updated_by_name: string | null;
          last_sync_at: string | null;
          last_error: string | null;
        }[];
      };
      vic_save_credentials: {
        Args: { p_username: string; p_password: string | null; p_is_active: boolean; p_farm_code?: string | null };
        Returns: undefined;
      };
      delpro_approve_jobs: { Args: { p_job_ids: string[] }; Returns: number };
      delpro_reject_job: { Args: { p_job_id: string; p_reason?: string }; Returns: undefined };
      delpro_retry_job: { Args: { p_job_id: string; p_refresh?: boolean }; Returns: undefined };
      generate_write_off_act: { Args: { p_data: Record<string, unknown> }; Returns: string };
      approve_write_off_act: { Args: { p_act_id: string }; Returns: undefined };
      cancel_write_off_act: { Args: { p_act_id: string }; Returns: undefined };
      set_write_off_allocations: { Args: { p_item_id: string; p_rows: Record<string, unknown>[] }; Returns: undefined };
      log_user_action: {
        Args: {
          p_action: string;
          p_table_name?: string;
          p_record_id?: string;
          p_old_data?: Record<string, unknown>;
          p_new_data?: Record<string, unknown>;
        };
        Returns: undefined;
      };
    };
  };
}

export type DelproPayload = {
  sync_id?: string;
  treatment_id: string;
  animal: { animal_id: string; delpro_animal_id: string | null; animal_no: string | null; tag_no: string };
  delpro: {
    event_date: string;
    diagnosis: string | null;
    diagnosis_code: string | null;
    diagnosis_text: string | null;
    treatment_code: string | null;
    products: Array<{
      product_id: string;
      name: string;
      qty: number;
      unit: Unit | null;
      administration_route: AdministrationRoute | null;
      delpro_code: string | null;
    }>;
    course_days: number | null;
    withdrawal_until_milk: string | null;
    withdrawal_until_meat: string | null;
    milk_withdrawal_days: number;
    meat_withdrawal_days: number;
    vet_name: string | null;
  };
};

type DelproSyncJobRow = {
  id: string;
  treatment_id: string;
  status: DelproSyncJobStatus;
  approved_payload: DelproPayload | null;
  auto_approved: boolean;
  approved_by: string | null;
  approved_at: string | null;
  rejected_by: string | null;
  rejected_at: string | null;
  rejection_reason: string | null;
  worker_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  attempts: number;
  actual_result: Record<string, unknown> | null;
  verified: boolean;
  verified_at: string | null;
  error: string | null;
  error_details: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};
