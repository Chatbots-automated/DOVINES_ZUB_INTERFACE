// Hand-written to match supabase/migrations/*.sql. Keep in sync manually,
// or regenerate later with `supabase gen types typescript` once the
// Supabase CLI is linked to the project.

// 0024: two VIC logins — sėklinimo (stored) and veterinaro (daily animal import).
export type VicLoginKind = "seklinimas" | "veterinaras";
export type UserRole = "admin" | "vet" | "tech" | "viewer";
export type ProductCategory =
  | "medicines"
  | "vakcina"
  | "profilaktika"
  | "boliusai"
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
export type ProcedureType = "apziura" | "gydymas" | "profilaktika" | "sinchronizacija";
// animal_visits (0018_visits.sql) — text + check constraints.
export type VisitProcedure = "temperatura" | "apziura" | "profilaktika" | "gydymas" | "vakcina" | "sinchronizacija" | "sekinimas" | "kita";
// sync_protocol_steps.medications / animal_visits.planned_medications (0025_sync_protocols.sql).
export type SyncStepKind = "veiksmas" | "sekinimas";
export type SyncStepMedication = { product_id: string; qty: number; unit: Unit; administration_route: AdministrationRoute | null };
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
        // 0037 recommended_template_id <-> DelPro Diagnosis.RecommendedTreatment
        Row: Row<{ id: string; code: string | null; name: string; recommended_template_id: string | null; created_at: string }>;
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
          source: "manual" | "delpro" | "vic" | "delpro_report";
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
          // 0036 — DelPro Gateway Animal.ObjectGuid (for the Gateway treatment write)
          delpro_object_guid: string | null;
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
          /** Set when the treatment was created by a nagų apžiūra finding that used a drug / planned a course (0030). */
          hoof_finding_id: string | null;
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
          /** The planned visit for this course day (0035). */
          visit_id: string | null;
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
          sync_application_id: string | null;
          sync_step_title: string | null;
          sync_step_no: number | null;
          sync_step_total: number | null;
          planned_medications: SyncStepMedication[];
          created_by: string | null;
          created_at: string;
          updated_at: string;
        }>;
        Insert: Insertable<Database["public"]["Tables"]["animal_visits"]["Row"], "animal_id">;
        Update: Updatable<Database["public"]["Tables"]["animal_visits"]["Row"]>;
        Relationships: [];
      };

      sync_protocols: {
        Row: Row<{
          id: string;
          name: string;
          description: string | null;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        }>;
        Insert: Insertable<Database["public"]["Tables"]["sync_protocols"]["Row"], "name">;
        Update: Updatable<Database["public"]["Tables"]["sync_protocols"]["Row"]>;
        Relationships: [];
      };

      sync_protocol_steps: {
        Row: Row<{
          id: string;
          protocol_id: string;
          day_offset: number;
          title: string;
          notes: string | null;
          sort_order: number;
          kind: SyncStepKind;
          medications: SyncStepMedication[];
        }>;
        Insert: Insertable<Database["public"]["Tables"]["sync_protocol_steps"]["Row"], "protocol_id" | "day_offset" | "title">;
        Update: Updatable<Database["public"]["Tables"]["sync_protocol_steps"]["Row"]>;
        Relationships: [];
      };

      sync_protocol_applications: {
        Row: Row<{
          id: string;
          protocol_id: string | null;
          protocol_name: string;
          animal_id: string;
          start_date: string;
          applied_by: string | null;
          created_by: string | null;
          created_at: string;
        }>;
        Insert: Insertable<Database["public"]["Tables"]["sync_protocol_applications"]["Row"], "protocol_name" | "animal_id" | "start_date">;
        Update: Updatable<Database["public"]["Tables"]["sync_protocol_applications"]["Row"]>;
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
          visit_id: string | null;
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

      // 0036 — DelPro catalog sync. Read-only for the app (writes go through the delpro_catalog_* RPCs).
      delpro_catalog_runs: {
        Row: Row<DelproCatalogRunRow>;
        Insert: Insertable<DelproCatalogRunRow, never>;
        Update: Updatable<DelproCatalogRunRow>;
        Relationships: [];
      };
      delpro_catalog_items: {
        Row: Row<DelproCatalogItemRow>;
        Insert: Insertable<DelproCatalogItemRow, "object_type" | "delpro_key" | "fields" | "record_hash">;
        Update: Updatable<DelproCatalogItemRow>;
        Relationships: [];
      };
      delpro_catalog_links: {
        Row: Row<DelproCatalogLinkRow>;
        Insert: Insertable<DelproCatalogLinkRow, "object_type" | "delpro_key" | "origin">;
        Update: Updatable<DelproCatalogLinkRow>;
        Relationships: [];
      };
      // 0037 — GVET -> DelPro catalog write queue + GVET treatment templates
      delpro_catalog_jobs: {
        Row: Row<DelproCatalogJobRow>;
        Insert: Insertable<DelproCatalogJobRow, "object_type" | "operation" | "steps">;
        Update: Updatable<DelproCatalogJobRow>;
        Relationships: [];
      };
      treatment_templates: {
        Row: Row<TreatmentTemplateRow>;
        Insert: Insertable<TreatmentTemplateRow, "name">;
        Update: Updatable<TreatmentTemplateRow>;
        Relationships: [];
      };
      treatment_template_items: {
        Row: Row<TreatmentTemplateItemRow>;
        Insert: Insertable<TreatmentTemplateItemRow, "template_id" | "product_id" | "dosage">;
        Update: Updatable<TreatmentTemplateItemRow>;
        Relationships: [];
      };
      // 0042 — DelPro daily Excel reports (read-only for the app; written by delpro_report_ingest)
      delpro_report_upload_tokens: {
        Row: Row<DelproReportTokenRow>;
        Insert: Insertable<DelproReportTokenRow, never>;
        Update: Updatable<DelproReportTokenRow>;
        Relationships: [];
      };
      delpro_report_imports: {
        Row: Row<DelproReportImportRow>;
        Insert: Insertable<DelproReportImportRow, never>;
        Update: Updatable<DelproReportImportRow>;
        Relationships: [];
      };
      delpro_report_rows: {
        Row: Row<DelproReportRowRow>;
        Insert: Insertable<DelproReportRowRow, never>;
        Update: Updatable<DelproReportRowRow>;
        Relationships: [];
      };
      delpro_report_animal_state: {
        Row: Row<DelproReportAnimalStateRow>;
        Insert: Insertable<DelproReportAnimalStateRow, never>;
        Update: Updatable<DelproReportAnimalStateRow>;
        Relationships: [];
      };
      delpro_report_fields: {
        Row: Row<DelproReportFieldRow>;
        Insert: Insertable<DelproReportFieldRow, never>;
        Update: Updatable<DelproReportFieldRow>;
        Relationships: [];
      };
      delpro_report_reviews: {
        Row: Row<DelproReportReviewRow>;
        Insert: Insertable<DelproReportReviewRow, never>;
        Update: Updatable<DelproReportReviewRow>;
        Relationships: [];
      };
      delpro_report_failures: {
        Row: Row<DelproReportFailureRow>;
        Insert: Insertable<DelproReportFailureRow, never>;
        Update: Updatable<DelproReportFailureRow>;
        Relationships: [];
      };
      delpro_catalog_issues: {
        Row: Row<DelproCatalogIssueRow>;
        Insert: Insertable<DelproCatalogIssueRow, "issue_type" | "object_type" | "fingerprint">;
        Update: Updatable<DelproCatalogIssueRow>;
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
      // 0032_analytics.sql — money = qty × per-unit purchase_price.
      vw_stock_value_by_category: {
        Row: Row<{
          category: ProductCategory;
          usable_value: number;
          usable_batches: number;
          expired_value: number;
          expired_batches: number;
          unpriced_batches: number;
        }>;
        Relationships: [];
      };
      vw_stock_batch_alerts: {
        Row: Row<{
          batch_id: string;
          product_id: string;
          product_name: string;
          category: ProductCategory;
          unit: Unit;
          lot: string | null;
          expiry_date: string;
          days_left: number;
          qty_left: number;
          value: number;
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
          procedure_type: ProcedureType;
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
            // 0033 — appended view columns
            preview_problems: DelproTransferProblem[] | null;
            payload_stale: boolean;
            approved_by_name: string | null;
          }
        >;
        Relationships: [];
      };
      vw_delpro_catalog_items: {
        Row: Row<
          DelproCatalogItemRow & {
            link_id: string | null;
            link_origin: DelproCatalogLinkRow["origin"] | null;
            disease_id: string | null;
            product_id: string | null;
            gvet_name: string | null;
            template_id: string | null;
          }
        >;
        Relationships: [];
      };
      vw_treatment_templates: {
        Row: Row<
          TreatmentTemplateRow & {
            delpro_key: string | null;
            items: (Omit<TreatmentTemplateItemRow, "template_id" | "sort_order" | "delpro_params_key" | "created_at"> & {
              product_name: string;
              unit: Unit;
            })[];
            diseases: { id: string; name: string }[];
          }
        >;
        Relationships: [];
      };
      vw_delpro_catalog_summary: {
        Row: Row<{
          object_type: DelproCatalogObjectType;
          items: number;
          linked: number;
          unlinked: number;
          removed: number;
          last_seen_at: string | null;
          complete: boolean;
        }>;
        Relationships: [];
      };
      vw_delpro_catalog_gvet_unlinked: {
        Row: Row<{ object_type: "Diagnosis" | "Drug" | "Treatment"; gvet_table: "diseases" | "products" | "treatment_templates"; gvet_id: string; name: string }>;
        Relationships: [];
      };
      vw_delpro_catalog_treatments: {
        Row: Row<{
          code: string;
          name: string | null;
          active: boolean | null;
          treatment_type: string | null;
          removed_at: string | null;
          drug_usages: DelproTemplateDrugUsage[];
          recommended_for: number;
        }>;
        Relationships: [];
      };
      vw_delpro_catalog_issues: {
        Row: Row<DelproCatalogIssueRow & { delpro_name: string | null; gvet_name: string | null }>;
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
      analytics_monthly: { Args: { p_from: string; p_to: string }; Returns: { month: string; purchased: number; consumed: number }[] };
      analytics_spend_by_category: { Args: { p_from: string; p_to: string }; Returns: { category: ProductCategory; spent: number; uses: number }[] };
      analytics_top_products: {
        Args: { p_from: string; p_to: string; p_limit?: number };
        Returns: { product_id: string; product_name: string; category: ProductCategory; unit: Unit; qty: number; spent: number; uses: number; is_antimicrobial: boolean }[];
      };
      analytics_antimicrobial: {
        Args: { p_from: string; p_to: string; p_limit?: number };
        Returns: { product_name: string; active_substance: string | null; unit: Unit; qty: number; uses: number }[];
      };
      analytics_treatments_by_month: { Args: { p_from: string; p_to: string }; Returns: { month: string; procedure_type: ProcedureType; n: number }[] };
      analytics_top_diseases: { Args: { p_from: string; p_to: string; p_limit?: number }; Returns: { name: string; n: number; animals: number }[] };
      analytics_treatments_by_group: { Args: { p_from: string; p_to: string; p_limit?: number }; Returns: { animal_group: string; n: number; animals: number }[] };
      create_treatment: { Args: { p_data: Record<string, unknown> }; Returns: string };
      administer_course_dose: { Args: { p_dose_id: string; p_date?: string }; Returns: undefined };
      create_vaccinations: { Args: { p_data: Record<string, unknown> }; Returns: number };
      create_hoof_exam: { Args: { p_data: Record<string, unknown> }; Returns: string };
      create_insemination: { Args: { p_data: Record<string, unknown> }; Returns: string };
      generate_pazymejimo_nr: { Args: { p_vet_code: string }; Returns: string };
      create_biocide_usage: { Args: { p_data: Record<string, unknown> }; Returns: string };
      create_visit: { Args: { p_data: Record<string, unknown> }; Returns: string };
      create_treatment_with_visits: { Args: { p_data: Record<string, unknown>; p_visit_id?: string }; Returns: string };
      create_treatment_for_visit: { Args: { p_visit_id: string; p_data: Record<string, unknown> }; Returns: string };
      create_insemination_for_visit: { Args: { p_visit_id: string; p_data: Record<string, unknown> }; Returns: string };
      create_vaccination_for_visit: { Args: { p_visit_id: string; p_data: Record<string, unknown> }; Returns: number };
      save_sync_protocol: { Args: { p_data: Record<string, unknown> }; Returns: string };
      apply_sync_protocol: {
        Args: { p_protocol_id: string; p_animal_id: string; p_start_date: string; p_start_time?: string; p_vet_name?: string | null };
        Returns: number;
      };
      cancel_sync_application: { Args: { p_application_id: string }; Returns: number };
      receive_invoice: { Args: { p_data: Record<string, unknown> }; Returns: { invoice_id: string | null; batches: number; total: number } };
      delete_invoice: { Args: { p_invoice_id: string }; Returns: undefined };
      create_general_usage: { Args: { p_data: Record<string, unknown> }; Returns: number };
      vic_get_settings: {
        Args: { p_kind: VicLoginKind };
        Returns: {
          vic_username: string;
          vic_farm_code: string | null;
          // 0040: the farm the veterinarian login imports from
          vic_farm_id: string | null;
          vic_farm_name: string | null;
          vic_client_personal_code: string | null;
          password_set: boolean;
          is_active: boolean;
          updated_at: string;
          updated_by_name: string | null;
          last_sync_at: string | null;
          last_error: string | null;
        }[];
      };
      vic_save_credentials: {
        Args: {
          p_kind: VicLoginKind;
          p_username: string;
          p_password: string | null;
          p_is_active: boolean;
          p_farm_code?: string | null;
          p_farm_id?: string | null;
          p_farm_name?: string | null;
          p_client_personal_code?: string | null;
        };
        Returns: undefined;
      };
      delpro_approve_jobs: { Args: { p_job_ids: string[] }; Returns: number };
      delpro_reject_job: { Args: { p_job_id: string; p_reason?: string }; Returns: undefined };
      delpro_retry_job: { Args: { p_job_id: string; p_refresh?: boolean }; Returns: undefined };
      // 0033 — treatment-level confirmation (same approval core as the queue)
      delpro_approve_treatment: { Args: { p_treatment_id: string; p_reapprove?: boolean }; Returns: DelproApprovalResult };
      delpro_treatment_transfer_state: { Args: { p_treatment_id: string }; Returns: DelproTransferState };
      // 0036 — DelPro catalog (admin only; checked in the database)
      delpro_catalog_request_sync: { Args: Record<string, never>; Returns: undefined };
      delpro_catalog_link: { Args: { p_object_type: string; p_delpro_key: string; p_gvet_id: string }; Returns: DelproCatalogActionResult };
      delpro_catalog_unlink: { Args: { p_link_id: string; p_reason?: string }; Returns: DelproCatalogActionResult };
      delpro_catalog_confirm_suggestions: { Args: Record<string, never>; Returns: DelproCatalogActionResult & { linked: number; skipped: number } };
      delpro_catalog_resolve_issue: { Args: { p_issue_id: string; p_action: DelproCatalogIssueAction }; Returns: DelproCatalogActionResult };
      // 0037
      delpro_catalog_enqueue_create: { Args: { p_object_type: string; p_gvet_id: string }; Returns: DelproCatalogActionResult };
      delpro_catalog_create_test_job: { Args: { p_operation_key: string }; Returns: DelproCatalogActionResult };
      delpro_catalog_mark_validated: { Args: { p_job_id: string }; Returns: DelproCatalogActionResult };
      delpro_catalog_unvalidate: { Args: { p_operation_key: string }; Returns: DelproCatalogActionResult };
      delpro_catalog_set_write_enabled: { Args: { p_enabled: boolean }; Returns: DelproCatalogActionResult };
      delpro_catalog_job_action: {
        Args: { p_job_id: string; p_action: "cancel" | "retry" | "adopt" | "resend"; p_step?: string; p_key?: string };
        Returns: DelproCatalogActionResult;
      };
      save_treatment_template: { Args: { p_data: Record<string, unknown> }; Returns: string };
      delete_treatment_template: { Args: { p_id: string }; Returns: undefined };
      // 0039 — import with preview + approval; the pilot medicine and its single-job release
      delpro_catalog_import_preview: {
        Args: { p_object_type?: "Diagnosis" | "Drug" };
        Returns: { rows: DelproImportPlanRow[]; counts: Record<string, number>; drug_parameters_complete: boolean };
      };
      delpro_catalog_import_apply: {
        Args: { p_items: { object_type: string; delpro_key: string; action: "create" | "link"; fingerprint: string }[] };
        Returns: DelproCatalogActionResult & { created: number; linked: number; skipped: { key: string; name?: string | null; reason: string }[] };
      };
      delpro_catalog_create_pilot_drug: { Args: Record<string, never>; Returns: DelproCatalogActionResult & { job_id: string; product_id: string } };
      delpro_catalog_release_single_job: { Args: { p_job_id: string }; Returns: DelproCatalogActionResult };
      // 0042 — DelPro Excel report admin
      delpro_report_create_token: { Args: { p_label: string }; Returns: DelproCatalogActionResult & { id: string; token: string } };
      delpro_report_revoke_token: { Args: { p_id: string }; Returns: DelproCatalogActionResult };
      delpro_report_resolve_review: { Args: { p_id: string; p_status: "resolved" | "dismissed" }; Returns: DelproCatalogActionResult };
      delpro_report_update_field: {
        Args: { p_key: string; p_label: string | null; p_visible: boolean | null; p_sort_order: number | null };
        Returns: DelproCatalogActionResult;
      };
      delpro_catalog_import: {
        Args: { p_object_type: "Diagnosis" | "Drug" | "Treatment"; p_delpro_keys: string[] };
        Returns: DelproCatalogActionResult & { created: number; skipped: { key: string; name: string | null; reason: string }[] };
      };
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

/** One reason a treatment cannot be transferred yet (fn_delpro_transfer_problems, 0033). */
export type DelproTransferProblem = {
  code: string;
  message: string;
  /** The mapping that has to be created, when the problem is a missing/invalid mapping. */
  fix: { kind: "disease" | "product"; local_id: string; name: string | null } | null;
};

export type DelproApprovalOutcome =
  | "approved"
  | "reapproved"
  | "already_approved"
  | "already_processing"
  | "already_success"
  | "stale"
  | "blocked"
  | "needs_retry"
  | "rejected";

/** Return value of delpro_approve_treatment (and the core behind delpro_approve_jobs). */
export type DelproApprovalResult = {
  ok: boolean;
  outcome: DelproApprovalOutcome;
  status: DelproSyncJobStatus | null;
  job_id: string | null;
  problems: DelproTransferProblem[];
  message: string;
};

/** Read model behind the confirmation dialog (delpro_treatment_transfer_state, 0033). */
export type DelproTransferState =
  | { found: false }
  | {
      found: true;
      procedure_type: ProcedureType;
      mode: DelproOutboundMode;
      eligible: boolean;
      can_approve: boolean;
      is_admin: boolean;
      job: {
        id: string;
        status: DelproSyncJobStatus;
        approved_at: string | null;
        approved_by_name: string | null;
        auto_approved: boolean;
        started_at: string | null;
        completed_at: string | null;
        attempts: number;
        verified: boolean;
        error: string | null;
        rejection_reason: string | null;
        admin_approval_required: boolean;
        next_attempt_at: string | null;
      } | null;
      /** What was frozen at approval, or the live preview while nothing is frozen. */
      payload: DelproPayload;
      frozen: boolean;
      /** The live data as it would be frozen right now. */
      preview: DelproPayload;
      /** True when a frozen payload no longer matches the treatment / mappings. */
      stale: boolean;
      problems: DelproTransferProblem[];
      /** outbound_mode / treatment_model_ready: the farm PC's last heartbeat (null = not reported). */
      worker: { last_seen_at: string | null; online: boolean; outbound_mode: string | null; treatment_model_ready: boolean | null };
    };

/**
 * The parameter set the farm-PC UI automation (delpro.ps1) understands — built
 * by the database (fn_build_delpro_payload, payload v2). The worker validates
 * these and passes them as an argument ARRAY; they are never shell text.
 */
export type DelproUiEntry = {
  treatment_id: string; // -> TreatmentId
  animal_number: string | null; // -> AnimalNumber
  diagnosis_name: string | null; // -> DiagnosisName
  diagnosis_code: string | null; // -> DiagnosisCode
  medicine_name: string | null; // -> MedicineName (null unless exactly one medicine)
  dose: number | null; // -> Dose
  dose_unit: Unit | null; // informational
  course_days: number; // -> CourseDays (1 = no course)
};

export type DelproPayload = {
  sync_id?: string;
  payload_version?: number;
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
      delpro_name?: string | null;
    }>;
    course_days: number | null;
    withdrawal_until_milk: string | null;
    withdrawal_until_meat: string | null;
    milk_withdrawal_days: number;
    meat_withdrawal_days: number;
    vet_name: string | null;
    ui_entry?: DelproUiEntry;
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
  // 0037 — Gateway channel
  gateway_entry: Record<string, unknown> | null;
  requires_verification: boolean;
  // 0045 — queued while the temporary admin gate was on: only an administrator releases it
  admin_approval_required: boolean;
};

// ---------------------------------------------------------------------------
// DelPro catalog sync (0036_delpro_catalog_sync.sql)
// ---------------------------------------------------------------------------

export type DelproCatalogObjectType = "Drug" | "DrugParameters" | "Diagnosis" | "Treatment" | "TreatmentDrugUsage";

export type DelproCatalogIssueType =
  | "suggested_match"
  | "ambiguous_match"
  | "field_difference"
  | "inbound_change"
  | "outbound_pending"
  | "conflict"
  | "removed_in_delpro"
  | "broken_reference"
  | "clinical_review";

export type DelproCatalogIssueAction = "confirm" | "take_delpro" | "keep_gvet" | "send" | "unlink" | "reviewed" | "dismiss";

export type DelproCatalogActionResult = { ok: boolean; message: string };

/** 0042: one stored report value. `local` = the Vilnius wall-clock text a timestamp was written as. */
export type DelproReportValue = {
  value: string | number | boolean | null;
  type: "text" | "number" | "date" | "timestamp" | "boolean" | "empty";
  local?: string;
  raw: string | null;
  header: string;
  /** current state only: which report the value came from */
  report_at?: string;
  import_id?: string;
  row_id?: string;
};

type DelproReportTokenRow = {
  id: string;
  farm_id: string;
  label: string;
  token_hash: string;
  token_hint: string;
  created_by: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
};

type DelproReportImportRow = {
  id: string;
  farm_id: string;
  token_id: string | null;
  report_type: string;
  filename: string;
  sha256: string;
  size_bytes: number | null;
  report_at: string;
  report_at_source: "filename" | "workbook" | "received";
  report_at_local: string | null;
  sheets: { name: string; header_row: number; rows: number }[];
  columns: { header: string; key: string; known: boolean; data_type: string }[];
  rows_received: number;
  rows_imported: number;
  footer_rows: number;
  matched: number;
  created: number;
  updated: number;
  stale: number;
  conflicts: number;
  errors: { sheet?: string; row?: number; error: string }[];
  supersedes_import_id: string | null;
  received_at: string;
};

type DelproReportRowRow = {
  id: string;
  import_id: string;
  farm_id: string;
  animal_id: string | null;
  orn: string;
  sheet_name: string | null;
  row_number: number;
  report_at: string;
  fields: Record<string, DelproReportValue>;
  raw: Record<string, string | null>;
  outcome: "created" | "updated" | "unchanged" | "stale" | "conflict" | "duplicate" | "invalid";
};

type DelproReportAnimalStateRow = {
  animal_id: string;
  farm_id: string;
  orn: string;
  latest_report_at: string;
  latest_import_id: string | null;
  latest_row_id: string | null;
  fields: Record<string, DelproReportValue>;
  updated_at: string;
};

type DelproReportFieldRow = {
  key: string;
  label: string;
  aliases: string[];
  headers_seen: string[];
  data_type: "text" | "number" | "date" | "timestamp" | "boolean" | "orn";
  known: boolean;
  visible: boolean;
  sort_order: number;
  first_seen_at: string | null;
  last_seen_at: string | null;
  last_import_id: string | null;
  seen_count: number;
};

type DelproReportReviewRow = {
  id: string;
  farm_id: string;
  import_id: string | null;
  row_id: string | null;
  animal_id: string | null;
  orn: string | null;
  kind: "ambiguous_animal" | "birth_date_conflict" | "duplicate_orn_row" | "invalid_orn";
  details: Record<string, unknown>;
  status: "open" | "resolved" | "dismissed";
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
};

type DelproReportFailureRow = {
  id: string;
  farm_id: string;
  token_id: string | null;
  filename: string | null;
  sha256: string | null;
  stage: string;
  error: string;
  created_at: string;
};

/** 0039 import plan: one decision per unlinked DelPro diagnosis / drug. */
export type DelproImportAction = "create" | "link" | "review" | "blocked" | "linked";
export type DelproImportPlanRow = {
  object_type: "Diagnosis" | "Drug";
  delpro_key: string;
  delpro_name: string | null;
  delpro_active: boolean | null;
  action: DelproImportAction;
  reason: string | null;
  match_source: "mapping" | "name" | null;
  gvet_id: string | null;
  gvet_name: string | null;
  candidates: { gvet_id: string; name: string; source: "mapping" | "name"; linked: boolean }[];
  delpro_values: {
    name: string | null;
    active: boolean | null;
    active_substance?: string | null;
    params_key?: string | null;
    uom?: string | null;
    unit?: string | null;
    milk_days?: number | null;
    meat_days?: number | null;
    application_method?: string | null;
  };
  gvet_values: Record<string, unknown> | null;
  fingerprint: string;
};

/** Per object type in delpro_catalog_runs.stats (plus "Animal" for the ObjectGuid import). */
export type DelproCatalogRunTypeStats = {
  received?: number;
  inserted?: number;
  changed?: number;
  unchanged?: number;
  invalid?: number;
  errors?: { key: string | null; error: string }[];
  returned?: number | null;
  limit?: number | null;
  seen?: number;
  complete?: boolean;
  removed?: number;
  note?: string | null;
  // Animal
  matched?: number;
  unmatched?: number;
  ambiguous?: number;
  conflicts?: number;
};

type DelproCatalogRunRow = {
  id: string;
  worker_id: string | null;
  status: "running" | "completed" | "failed";
  stats: Record<string, DelproCatalogRunTypeStats>;
  reconcile: { opened: number; closed: number; auto_applied: number; open: number } | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
};

type DelproCatalogItemRow = {
  id: string;
  object_type: DelproCatalogObjectType;
  delpro_key: string;
  name: string | null;
  active: boolean | null;
  fields: Record<string, unknown>;
  record_hash: string;
  raw: Record<string, unknown> | null;
  last_run_id: string | null;
  first_seen_at: string;
  last_seen_at: string;
  changed_at: string;
  removed_at: string | null;
};

type DelproCatalogLinkRow = {
  id: string;
  object_type: "Diagnosis" | "Drug" | "Treatment";
  delpro_key: string;
  disease_id: string | null;
  product_id: string | null;
  template_id: string | null;
  origin: "matched" | "manual" | "imported" | "created";
  synced_fields: Record<string, unknown> | null;
  synced_hash: string | null;
  synced_at: string | null;
  linked_by: string | null;
  linked_at: string;
  retired_at: string | null;
  retired_by: string | null;
  retire_reason: string | null;
  /** 0039: provenance of a link made by the DelPro import (DelPro record, parameters, match source, run). */
  import_snapshot: Record<string, unknown> | null;
};

/** A field compared on a link: DelPro value, GVET value, last agreed value (null = never agreed). */
export type DelproCatalogFieldDiff = { delpro: unknown; gvet: unknown; synced: unknown | null };

export type DelproCatalogIssueDetails = {
  delpro_name?: string | null;
  gvet_name?: string | null;
  candidate?: { gvet_table: string; gvet_id: string; name: string; linked: boolean };
  candidates?: { gvet_table: string; gvet_id: string; name: string; linked: boolean }[];
  same_name_in_delpro?: number;
  fields?: Record<string, DelproCatalogFieldDiff>;
  missing?: { field: string; object_type: DelproCatalogObjectType; key: string }[];
  uom?: string | null;
  milk_days?: number | null;
  meat_days?: number | null;
  application_method?: string | null;
  usages?: DelproTemplateUsageValue[];
};

/** One drug line of a template as compared between GVET and DelPro (0037 fn_delpro_*_usages). */
export type DelproTemplateUsageValue = {
  drug: string;
  dosage: number | null;
  frequency: number | null;
  treat_cow_days: number | null;
  uom: string | null;
  application_method: string | null;
  milk_days: number | null;
  meat_days: number | null;
};

export type DelproCatalogJobStatus = "queued" | "processing" | "success" | "failed" | "verification_failed" | "needs_review" | "cancelled";

export type DelproCatalogJobStep = {
  id: string;
  object: string;
  operation: "create" | "update" | "verify_refs";
  key_property: string;
  key?: string;
  lookup_name?: string;
  item_id?: string;
  properties?: { name: string; value?: unknown; object_type?: string; ref_step?: string }[];
};

type DelproCatalogJobRow = {
  id: string;
  object_type: "Diagnosis" | "Drug" | "Treatment";
  operation: "create" | "update";
  is_test: boolean;
  /** 0039: the one pilot medicine (first real Drug.create); released alone via delpro_catalog_release_single_job. */
  pilot: boolean;
  link_id: string | null;
  disease_id: string | null;
  product_id: string | null;
  template_id: string | null;
  delpro_key: string | null;
  label: string | null;
  steps: DelproCatalogJobStep[];
  gvet_values: Record<string, unknown> | null;
  /** adopted_* / resend_confirmed_*: an admin's decision on a step whose earlier write had an unknown outcome. */
  progress: Record<
    string,
    { started_at?: string; done_at?: string; key?: string | null; adopted_by?: string; adopted_at?: string; resend_confirmed_by?: string; resend_confirmed_at?: string }
  >;
  status: DelproCatalogJobStatus;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string | null;
  worker_id: string | null;
  lease_expires_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  readback: unknown;
  error: string | null;
  error_details: Record<string, unknown> | null;
  validated_at: string | null;
  validated_by: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

type TreatmentTemplateRow = {
  id: string;
  name: string;
  active: boolean;
  treatment_type: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

type TreatmentTemplateItemRow = {
  id: string;
  template_id: string;
  sort_order: number;
  product_id: string;
  dosage: number;
  frequency: number;
  treat_cow_days: number;
  uom: string | null;
  application_method: string | null;
  milk_days: number;
  meat_days: number;
  delpro_usage_key: string | null;
  delpro_params_key: string | null;
  created_at: string;
};

type DelproCatalogIssueRow = {
  id: string;
  issue_type: DelproCatalogIssueType;
  object_type: string;
  delpro_key: string | null;
  link_id: string | null;
  gvet_table: "diseases" | "products" | "treatment_templates" | null;
  gvet_id: string | null;
  fingerprint: string;
  details: DelproCatalogIssueDetails;
  status: "open" | "resolved" | "dismissed";
  resolution: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
};

export type DelproTemplateDrugUsage = {
  key: string;
  drug_code: string | null;
  drug_name: string | null;
  dosage: number | null;
  frequency: number | null;
  treat_cow_days: number | null;
  uom: string | null;
  application_method: string | null;
  dump_milk_days: number | null;
  meat_withhold_days: number | null;
};
