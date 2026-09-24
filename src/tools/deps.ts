import type {
  Environment,
  InfrastructureProvider,
  ResourceType
} from "../infra";
import type { ResourceStore } from "../infra/store";
import type { ProvisionOutcome } from "../workflows/types";

// What every infra tool needs. Passed in (rather than imported) so each tool
// file stays a small, easily-read function of its dependencies.
export interface ToolDeps {
  store: ResourceStore;
  provider: InfrastructureProvider;
  // Reserves an id, runs the provisioning Workflow and waits for its result.
  provisionResource(input: {
    type: ResourceType;
    env: Environment;
    owner?: string;
  }): Promise<ProvisionOutcome>;
  // The user's last couple of messages, used to check that the model did not
  // invent tool arguments the user never said (see create-resource.ts).
  recentUserText: string;
}
