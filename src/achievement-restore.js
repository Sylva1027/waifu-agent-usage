import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { ACHIEVEMENT_CATALOG } from "./achievement-catalog.js";
import { AchievementOperationService } from "./achievement-operations.js";
import { AchievementStore } from "./achievement-store.js";

/** Local restore coordination; an imported package can never nominate the initiating profile. */
export async function runAchievementRestore({
  archiveFile,
  packageDigest,
  target,
  restore,
  verifyCompleted,
  fullProfile = false,
}) {
  if (!existsSync(archiveFile)) return { result: await restore(), replayed: false };
  const archive = new AchievementStore({ databaseFile: archiveFile, catalog: ACHIEVEMENT_CATALOG });
  let service;
  try {
    archive.open();
    service = new AchievementOperationService({ archive });
  } catch (error) {
    archive.close();
    return { result: await restore(), replayed: false, achievementError: error.message };
  }
  try {
    const destination = path.resolve(target);
    const profileId = archive.readProfile().profileId;
    const operationId = createHash("sha256")
      .update(JSON.stringify([profileId, packageDigest, destination, fullProfile]))
      .digest("hex");
    const directory = path.join(path.dirname(archiveFile), ".achievement-restores");
    const receiptFile = path.join(directory, `${operationId}.receipt.json`);
    const intentFile = path.join(directory, `${operationId}.intent.json`);
    if (existsSync(receiptFile)) {
      service.replayRestoreSuccess(receiptFile);
      if (existsSync(destination)) {
        await verifyCompleted();
        return { replayed: true };
      }
      return { result: await restore(), replayed: false };
    }
    const intent = { profileId, packageDigest, target: destination, operationId, fullProfile };
    let previousIntent = false;
    try {
      const saved = JSON.parse(await readFile(intentFile, "utf8"));
      if (JSON.stringify(saved) !== JSON.stringify(intent))
        throw new Error("Restore intent does not match this operation");
      previousIntent = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (!previousIntent) {
      if (existsSync(destination))
        throw Object.assign(new Error("Restore destination already exists"), { code: "EEXIST" });
      await mkdir(directory, { recursive: true });
      const temporary = `${intentFile}.creating-${randomUUID()}`;
      try {
        await writeFile(temporary, JSON.stringify(intent), { flag: "wx", mode: 0o600, flush: true });
        await link(temporary, intentFile);
      } finally {
        await unlink(temporary).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
    }
    let result;
    let replayed = false;
    if (previousIntent && existsSync(destination)) {
      await verifyCompleted();
      replayed = true;
    } else result = await restore();
    try {
      service.persistRestoreSuccess({ receiptFile, operationId, packageDigest, target: destination });
      service.replayRestoreSuccess(receiptFile);
      return { result, replayed };
    } catch (error) {
      // A verified restore remains successful; its intent allows bookkeeping to resume without overwriting the target.
      return { result, replayed, achievementError: error.message };
    }
  } finally {
    archive.close();
  }
}
