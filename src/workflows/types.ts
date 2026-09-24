import type { Environment, Resource, ResourceType } from "../infra";

// Everything shared between the agent (which starts the Workflow and waits for
// it) and the Workflow itself. Types only, so importing this is always safe.

export interface ProvisionParams {
  id: string;
  type: ResourceType;
  env: Environment;
  owner?: string;
}

export const PROVISION_STEPS = [
  "validatePolicy",
  "provision",
  "verifyHealth",
  "record"
] as const;
export type ProvisionStepName = (typeof PROVISION_STEPS)[number];

// Sent to the agent (and on to the browser) as each step starts, finishes or
// is about to be retried. This is what makes the retry visible in the UI.
export interface ProvisionProgress {
  id: string;
  step: ProvisionStepName;
  status: "running" | "complete" | "retrying" | "rejected";
  attempt?: number;
  message?: string;
}

// What the Workflow reports when it finishes normally. A policy rejection is a
// normal outcome, not an error: it must reach the user as a clear message, and
// an exception would trigger retries.
export type ProvisionResult =
  | { status: "running"; id: string }
  | { status: "rejected"; id: string; reason: string };

// What the createResource tool gets back once the Workflow is done.
export type ProvisionOutcome =
  | { status: "running"; resource: Resource }
  | { status: "rejected"; reason: string }
  | { status: "failed"; error: string }
  | { status: "timeout"; message: string };
