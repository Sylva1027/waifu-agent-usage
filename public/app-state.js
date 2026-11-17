import { createDashboardState } from "./usage-dashboard-state.js";
export const state = {
  ...createDashboardState(),
  theme: "light",
  pricingCatalog: null,
  usdToCnyRate: 6.72,
  costScaleTarget: "USD",
  pricingSearch: "",
  pricingProvider: null,
  pricingSeenModels: new Set(),
  restoreAutomaticExchangeRate: false,
  modelPricingDraft: null,
};
