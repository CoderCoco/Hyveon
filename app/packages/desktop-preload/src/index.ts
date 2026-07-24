export type {
  GsdApi,
  GsdTestApi,
  GsdMockNamespaces,
  TerraformRunChunk,
  TerraformRunKind,
  TerraformRunRecord,
  RunDetailStatus,
  TerraformRunsGetResult,
  TerraformPlanAck,
  TerraformApplyPayload,
  TerraformApproveAck,
} from './gsd-api.js';

declare global {
  interface Window {
    gsd?: import('./gsd-api.js').GsdApi;
  }
}

export {};
