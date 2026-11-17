import { createRangeMetricsAccumulator } from "../../public/range-metrics.js";
import { createTimelineAccumulator } from "../../public/waifu-timeline.js";
import { createCostEstimateAccumulator, estimateCostForEvents, estimateEventCost } from "../pricing.js";

export function createWaifuSummaryExtension(range, bucket, sourceKinds, modelName) {
  let rangeMetrics = createRangeMetricsAccumulator(range.calendarZone, sourceKinds);
  const cost = createCostEstimateAccumulator();
  return {
    createTimeline: () =>
      createTimelineAccumulator(range, bucket, {
        sourceKinds,
        modelName,
        estimateCost: estimateEventCost,
        onEstimate: (event, estimate) => {
          cost.add(event, estimate);
          rangeMetrics.add(event);
        },
      }),
    result(timelineError, events) {
      if (timelineError) {
        rangeMetrics = createRangeMetricsAccumulator(range.calendarZone, sourceKinds);
        for (const event of events()) rangeMetrics.add(event);
      }
      return {
        costEstimate: timelineError ? estimateCostForEvents(events()) : cost.result(),
        rangeMetrics: rangeMetrics.result(),
      };
    },
  };
}
