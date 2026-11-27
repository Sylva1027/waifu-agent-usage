import { loadServiceTierEvidence } from "../service-tier-evidence.js";

export function createWaifuEventDecorator(homes) {
  const evidence = loadServiceTierEvidence(homes);
  return (event) => {
    if (event.sourceKind !== "hermes" && event.sourceKind !== "omp") {
      event.serviceTier = evidence.resolve(
        event.sessionId,
        event.timestampMs ?? Date.parse(event.timestamp),
        event.serviceTier,
      );
    }
  };
}
