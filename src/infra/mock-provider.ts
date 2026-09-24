import type {
  HealthResult,
  InfrastructureProvider,
  ProvisionRequest,
  ProvisionResult
} from "./provider";

// MOCK: nothing real is created anywhere. Each method waits briefly, as a
// network call would, then returns plausible data.

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class MockProvider implements InfrastructureProvider {
  readonly name = "mock";

  async provision(req: ProvisionRequest): Promise<ProvisionResult> {
    await sleep(300);
    return {
      providerRef: `mock://${req.type}/${req.id}`,
      createdAt: new Date().toISOString()
    };
  }

  async checkHealth(id: string): Promise<HealthResult> {
    await sleep(100);
    return { healthy: true, detail: `${id} responded OK (mock)` };
  }

  async deprovision(_id: string): Promise<void> {
    await sleep(200);
  }
}
