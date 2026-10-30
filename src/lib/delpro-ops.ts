// DelPro screen mutations, called through the Route Handler /api/delpro/action
// (src/lib/use-delpro-action.ts), not as Server Actions: on the DelPro page the
// Server Action POSTs came back as a non-RSC response ("An unexpected response
// was received from the server.") while the same request through /api/ — which
// the auth middleware does not intercept — returns plain JSON. The names map to
// the existing functions in src/lib/actions/delpro*.ts.
export const DELPRO_OPS = [
  // src/lib/actions/delpro.ts
  "approveDelproJobs",
  "confirmDelproTransfer",
  "rejectDelproJob",
  "retryDelproJob",
  "updateDelproSettings",
  "saveDelproMapping",
  // src/lib/actions/delpro-catalog.ts
  "requestCatalogSync",
  "confirmCatalogSuggestions",
  "resolveCatalogIssue",
  "linkCatalogRecord",
  "unlinkCatalogRecord",
  "importCatalogRecords",
  "applyCatalogImport",
  "createPilotDrug",
  "releaseSingleCatalogJob",
  "updateCatalogInboundMode",
  "enqueueCatalogCreate",
  "createCatalogTestJob",
  "markCatalogValidated",
  "unvalidateCatalogOperation",
  "setCatalogWriteEnabled",
  "catalogJobAction",
  "updateCatalogOutboundMode",
  "saveTreatmentTemplate",
  "deleteTreatmentTemplate",
  // src/lib/actions/delpro-report.ts (0042, Excel reports)
  "createReportUploadToken",
  "revokeReportUploadToken",
  "resolveReportReview",
  "updateReportField",
] as const;

export type DelproOp = (typeof DELPRO_OPS)[number];
