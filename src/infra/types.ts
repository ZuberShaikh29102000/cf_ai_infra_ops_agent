import { z } from "zod";

// Zod schemas are the single source of truth for what is a valid type/env.
// The tool input schemas reuse them, so a hallucinated value like "mysql" or
// "qa" is rejected before any tool code runs.
export const ResourceTypeSchema = z.enum([
  "redis",
  "postgres",
  "worker",
  "bucket"
]);
export const EnvironmentSchema = z.enum(["dev", "staging", "prod"]);

export type ResourceType = z.infer<typeof ResourceTypeSchema>;
export type Environment = z.infer<typeof EnvironmentSchema>;

// "provisioning": Workflow still running (P1). "running": healthy.
// "failed": the Workflow gave up. Deleted resources are removed, not flagged.
export type ResourceStatus = "provisioning" | "running" | "failed";

export interface Resource {
  id: string; // e.g. "redis-dev-01"
  type: ResourceType;
  env: Environment;
  status: ResourceStatus;
  owner?: string; // P1 policy: required for prod
  createdAt: string; // ISO 8601
}
