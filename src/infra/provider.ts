import type { Environment, ResourceType } from "./types";

// Everything the agent knows about "where infrastructure comes from" is this
// interface. To go from mock to real, write a class that implements it (e.g.
// one that drives Terraform or a cloud SDK) and change one line in ./index.ts.
//
// Deliberately stateless: the provider is handed an `id` and never remembers
// anything. The P1 Workflow runs in a different isolate from the agent, so an
// in-memory list inside a provider would silently diverge from the agent's
// own records. The agent's SQLite table is the only record of what exists.

export interface ProvisionRequest {
  id: string;
  type: ResourceType;
  env: Environment;
  owner?: string;
}

export interface ProvisionResult {
  // The provider's own handle for what it created (an ARN, a UUID...).
  providerRef: string;
  createdAt: string; // ISO 8601
}

export interface HealthResult {
  healthy: boolean;
  detail: string;
}

export interface InfrastructureProvider {
  readonly name: string;
  provision(req: ProvisionRequest): Promise<ProvisionResult>;
  checkHealth(id: string): Promise<HealthResult>;
  deprovision(id: string): Promise<void>;
}
