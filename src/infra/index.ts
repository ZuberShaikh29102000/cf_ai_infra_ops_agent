import type { InfrastructureProvider } from "./provider";
import { MockProvider } from "./mock-provider";

// The one place that decides which provider is in use. Swap this line to plug
// in a real implementation; nothing else in the app names MockProvider.
export function createProvider(): InfrastructureProvider {
  return new MockProvider();
}

export type { InfrastructureProvider } from "./provider";
export * from "./types";
