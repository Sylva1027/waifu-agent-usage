import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { loadPricingFile } from "../pricing-store.js";
import { loadServiceTierEvidence } from "../service-tier-evidence.js";
import { verifyHistoryBackup } from "../history-backup.js";
import { loadHistoryArchiveImport } from "../history-archive.js";

async function achievementFileForUsage(databaseFile) {
  const { achievementDatabaseFile } = await import("../achievement-foundation.js");
  const file = achievementDatabaseFile(databaseFile);
  try {
    return (await stat(file)).isFile() ? file : null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function withAchievementBackup(databaseFile, work) {
  const achievementDatabaseFile = await achievementFileForUsage(databaseFile);
  if (!achievementDatabaseFile) return work({});
  const { withAchievementBackupLock } = await import("../achievement-backup.js");
  return withAchievementBackupLock(achievementDatabaseFile, () => work({ achievementDatabaseFile }));
}

export const waifuCliFeatures = {
  loadPricing: loadPricingFile,
  restoreUsageSuffix: " [--with-achievements]",
  withAchievementBackup,
  serviceTierEvidence(homeDir, id, label) {
    return homeDir ? loadServiceTierEvidence([{ id, label, path: path.resolve(homeDir), kind: "main" }]) : null;
  },
  async restoreHistory({ bundle, verified, target, fullProfile, restore, homeDir }) {
    const { achievementDatabaseFile } = fullProfile
      ? await import("../achievement-foundation.js")
      : { achievementDatabaseFile: null };
    const extension = fullProfile
      ? { achievementDatabaseFile: achievementDatabaseFile(bundle ? path.join(target, "runtime.sqlite") : target) }
      : {};
    const verifyCompleted = async () => {
      if (bundle) {
        const loaded = await loadHistoryArchiveImport(target);
        if (JSON.stringify(loaded.manifest) !== JSON.stringify(verified.manifest))
          throw new Error("Restore target does not match the original bundle");
        if (fullProfile) {
          const { verifyAchievementBackup } = await import("../achievement-backup.js");
          await verifyAchievementBackup(path.dirname(extension.achievementDatabaseFile), {
            ...verified.manifest.achievements,
            filename: path.basename(extension.achievementDatabaseFile),
          });
        }
      } else {
        const completed = await verifyHistoryBackup(target);
        if (completed.manifest.database.sha256 !== verified.manifest.database.sha256)
          throw new Error("Restore target does not match the original backup");
      }
    };
    const { runAchievementRestore } = await import("../achievement-restore.js");
    return runAchievementRestore({
      archiveFile: path.join(homeDir, ".codex-usage", "achievements.sqlite"),
      packageDigest: createHash("sha256").update(JSON.stringify(verified.manifest)).digest("hex"),
      target,
      fullProfile,
      restore: () => restore(extension),
      verifyCompleted,
    });
  },
};
