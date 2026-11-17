import { automaticPricingFile, pricingFile } from "../pricing-store.js";
import { invalidateServiceTierLog } from "../service-tier-evidence.js";
import { invalidateQuotaSourceLog } from "../quota-source-evidence.js";
import { QUOTA_LOG_FILTER, readUsageLogInput, readUsageSourceInputs } from "../usage-source-inputs.js";

const EVIDENCE_FILTER = `(target='codex_core::session::handlers' AND feedback_log_body LIKE '%service_tier:%') OR ${QUOTA_LOG_FILTER}`;
const invalidate = (file) => {
  invalidateServiceTierLog(file);
  invalidateQuotaSourceLog(file);
};

export function readWaifuUsageSourceInputs(options, homes, fingerprint) {
  return readUsageSourceInputs(options, homes, fingerprint, {
    extraFiles: [pricingFile(options), automaticPricingFile(options)],
    readLogInput: (file) => readUsageLogInput(file, EVIDENCE_FILTER, invalidate),
  });
}
