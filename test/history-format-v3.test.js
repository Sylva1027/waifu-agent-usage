import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createHistoryBackup,
  loadHistoryBackupContext,
  restoreHistoryBackup,
  verifyHistoryBackup,
} from "../src/history-backup.js";
import {
  createHistoryArchiveCandidate,
  verifyHistoryArchiveCandidate,
  publishHistoryArchiveBundle,
  verifyPublishedHistoryArchiveBundle,
  stagePublishedHistoryArchiveBundle,
  publishHistoryArchiveImport,
  loadHistoryArchiveImport,
} from "../src/history-archive.js";
import { compactHistoryArchivePackage } from "../src/history-archive-compaction.js";
import {
  getPricingCatalog,
  getDefaultPricingCatalog,
  validatePricingCatalog as runtimeValidate,
  DEFAULT_USD_TO_CNY_RATE,
  MAX_PRICING_MODELS,
} from "../src/pricing.js";
import {
  validatePricingCatalog,
  REQUIRED_PRICING_MODELS,
  DEFAULT_USD_TO_CNY_RATE as FORMAT_RATE,
  MAX_PRICING_MODELS as FORMAT_MAX,
} from "../src/pricing-catalog-format.js";
import { serviceTierEvidenceFromSnapshot } from "../src/service-tier-evidence.js";
import { validateServiceTierEvidenceSnapshot } from "../src/service-tier-evidence-format.js";
import { AchievementStore } from "../src/achievement-store.js";
import { ACHIEVEMENT_CATALOG, ACHIEVEMENT_RULES_VERSION } from "../src/achievement-catalog.js";
import { UsageStore } from "../src/usage-store.js";
import { createLiteBoundaryProbe } from "../test-support/lite-boundary-probe.mjs";

const T0 = Date.parse("2026-07-11T00:00:00Z");
const DAY = 86_400_000;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const manifestFor = (file) => path.join(path.dirname(file), `${path.parse(file).name}.manifest.json`);
const json = (file) => JSON.parse(readFileSync(file, "utf8"));
const writeJson = (file, value) => writeFileSync(file, JSON.stringify(value));
const TIER = { formatVersion: 1, threads: [{ threadId: "session", turns: [{ time: T0, tier: "priority" }] }] };

async function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "history-format-v3-"));
  const store = new UsageStore({
    homeDir: root,
    databaseFile: path.join(root, "usage.sqlite"),
    env: {},
    importDirs: [],
    automaticDiscoveryEnabled: false,
  });
  const archiveFile = path.join(root, "source-achievements.sqlite");
  const archive = new AchievementStore({
    databaseFile: archiveFile,
    catalog: ACHIEVEMENT_CATALOG,
    clock: () => T0 + 100,
  });
  t.after(() => {
    store.close();
    archive.close();
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith("history-format-v3-"));
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  await store.open();
  const source = path.join(root, "events.jsonl");
  store.database
    .prepare("INSERT INTO source_files VALUES (?, 'codex', 'home', 'Home', ?, 1, 1, ?)")
    .run(source, root, new Date(T0).toISOString());
  const insert = store.database.prepare(`INSERT INTO events
    (source_path,timestamp_ms,session_id,home_id,home_label,channel,project,model,hour_key,day_key,week_key,month_key,total,input,cached,output,reasoning)
    VALUES (?,?,'session','home','Home','Codex','project','gpt-6-sol','hour','day','week','month',20,18,0,2,0)`);
  for (const offset of [1, DAY + 1, 2 * DAY + 1]) insert.run(source, T0 + offset);
  archive.open({
    enabledAt: T0,
    timeZone: "Asia/Shanghai",
    profileId: "history-format-profile",
    rulesVersion: ACHIEVEMENT_RULES_VERSION,
    catalogHash: hash(JSON.stringify(ACHIEVEMENT_CATALOG)),
  });
  archive.commitBatch({
    inputKey: "original",
    evaluatedThrough: T0 + 50,
    rows: ACHIEVEMENT_CATALOG.map(({ id }) => ({ id, observedValue: "20", nextTarget: "100" })),
    awards: [{ id: "A01", tier: "bronze", qualifiedAt: "2026-07-11", precision: "day" }],
    sourceCheckpoints: [{ kind: "hermes", key: "session", value: { baseline: "5" } }],
  });
  archive.putEvidence({ kind: "free", key: "policy", value: { source: "unchanged" } });
  archive.markSeen(1);
  const original = archive.readSnapshot();
  archive.close();
  return { root, store, archiveFile, original };
}

function errorOf(work) {
  try {
    work();
  } catch (error) {
    return { name: error.name, message: error.message };
  }
  assert.fail("invalid format accepted");
}

test("pure pricing validation retains the runtime's complete required directory, defaults, normalization and errors", () => {
  const original = getPricingCatalog();
  assert.deepEqual(REQUIRED_PRICING_MODELS, Object.keys(getDefaultPricingCatalog().models));
  assert.equal(FORMAT_RATE, DEFAULT_USD_TO_CNY_RATE);
  assert.equal(FORMAT_MAX, MAX_PRICING_MODELS);
  assert.deepEqual(validatePricingCatalog(original), runtimeValidate(original));
  const mutations = [
    (v) => {
      v.checkedAt = "2026-02-30";
    },
    (v) => {
      delete v.models[REQUIRED_PRICING_MODELS[0]];
    },
    (v) => {
      v.usdToCnyRate = 0;
    },
    (v) => {
      for (let i = 0; i < MAX_PRICING_MODELS; i++) v.models[`extra-${i}`] = v.models[REQUIRED_PRICING_MODELS[0]];
    },
    (v) => {
      v.models["Bad Name"] = {};
    },
  ];
  for (const [field, value] of Object.entries({
    currency: "EUR",
    short: { input: -1 },
    long: null,
    cacheWriteTtl: "1h",
    standardContextLimit: 0,
    fast: {},
    shortLongOutput: {},
    longContextThreshold: 0,
    outputThreshold: -1,
    offPeakMultiplier: 2,
    peakWindows: [],
    source: "file:///local",
  })) {
    mutations.push((v) => {
      v.models[REQUIRED_PRICING_MODELS[0]][field] = value;
    });
  }
  for (const mutate of mutations) {
    const value = structuredClone(original);
    mutate(value);
    assert.deepEqual(
      errorOf(() => validatePricingCatalog(value)),
      errorOf(() => runtimeValidate(value)),
    );
  }
  const before = JSON.stringify(original);
  validatePricingCatalog(original);
  assert.equal(JSON.stringify(original), before);
});

test("pure tier validation preserves exact keys, ordering, numeric and tier contracts", () => {
  assert.deepEqual(validateServiceTierEvidenceSnapshot(TIER), TIER);
  const values = [
    null,
    [],
    {},
    { ...TIER, formatVersion: 2 },
    { ...TIER, extra: true },
    { formatVersion: 1, threads: [TIER.threads[0], TIER.threads[0]] },
    { formatVersion: 1, threads: [{ threadId: " ", turns: [] }] },
    ...[
      { time: "1", tier: "priority" },
      { time: Infinity, tier: "priority" },
      { time: 1, tier: "paid" },
      { time: 1, tier: "priority", extra: true },
    ].map((turn) => ({ formatVersion: 1, threads: [{ threadId: "session", turns: [turn] }] })),
    {
      formatVersion: 1,
      threads: [
        { threadId: "z", turns: [] },
        { threadId: "a", turns: [] },
      ],
    },
    {
      formatVersion: 1,
      threads: [
        {
          threadId: "a",
          turns: [
            { time: 2, tier: "unknown" },
            { time: 1, tier: "fast" },
          ],
        },
      ],
    },
  ];
  for (const value of values)
    assert.deepEqual(
      errorOf(() => validateServiceTierEvidenceSnapshot(value)),
      errorOf(() => serviceTierEvidenceFromSnapshot(value)),
    );
});

for (const withAchievements of [false, true]) {
  test(`v3 explicit null pricing round-trips with achievements=${withAchievements} and no fabricated catalog`, async (t) => {
    const f = await fixture(t);
    const file = path.join(f.root, "no-price.sqlite");
    const manifest = await createHistoryBackup(f.store.database, file, {
      pricingCatalog: null,
      serviceTierSnapshot: TIER,
      ...(withAchievements ? { achievementDatabaseFile: f.archiveFile } : {}),
    });
    assert.equal(manifest.formatVersion, 3);
    for (const key of ["pricing", "pricingVersion", "pricingCheckedAt"]) assert.equal(manifest[key], null);
    assert.equal(!!manifest.achievements, withAchievements);
    assert.deepEqual(manifest.serviceTierEvidence.snapshot, TIER);
    const context = await loadHistoryBackupContext(file);
    assert.equal(context.pricingCatalog, null);
    assert.equal(context.serviceTierEvidence.resolve("session", T0 + 1), "priority");
    const ordinary = path.join(f.root, "ordinary.sqlite");
    await restoreHistoryBackup(file, ordinary);
    const restored = await verifyHistoryBackup(ordinary);
    assert.equal(restored.manifest.formatVersion, 3);
    assert.equal(restored.manifest.achievements, null);
    assert.equal(restored.manifest.pricing, null);
    if (withAchievements) {
      const archiveFile = path.join(f.root, "restored-achievements.sqlite");
      await restoreHistoryBackup(file, path.join(f.root, "full.sqlite"), undefined, {
        achievementDatabaseFile: archiveFile,
      });
      const archive = new AchievementStore({ databaseFile: archiveFile, catalog: ACHIEVEMENT_CATALOG });
      try {
        archive.open();
        assert.deepEqual(archive.readSnapshot(), f.original);
        assert.deepEqual(archive.readCheckpoints(), { session: { baseline: "5" } });
      } finally {
        archive.close();
      }
      assert.deepEqual(readFileSync(archiveFile), readFileSync(path.join(f.root, manifest.achievements.filename)));
    }
  });
}

test("v1 and v2 retain required pricing; v3 explicit markers, complete prices and tier snapshots fail closed", async (t) => {
  const f = await fixture(t);
  for (const version of [1, 2, 3]) {
    const file = path.join(f.root, `version-${version}.sqlite`);
    const manifest = await createHistoryBackup(f.store.database, file, {
      formatVersion: version,
      pricingCatalog: version === 3 ? null : getPricingCatalog(),
      serviceTierSnapshot: TIER,
      ...(version === 2 ? { achievementDatabaseFile: f.archiveFile } : {}),
    });
    assert.equal((await verifyHistoryBackup(file)).manifest.formatVersion, version);
    const changes =
      version === 3
        ? [
            (v) => {
              delete v.pricing;
            },
            (v) => {
              delete v.achievements;
            },
            (v) => {
              v.pricingVersion = "fake";
            },
          ]
        : [
            (v) => {
              v.pricing = null;
            },
            (v) => {
              delete v.pricing;
            },
            (v) => {
              v.pricing.sha256 = "0".repeat(64);
            },
            (v) => {
              v.pricing.catalog.models[REQUIRED_PRICING_MODELS[0]].short.input = -1;
              v.pricing.sha256 = hash(JSON.stringify(v.pricing.catalog));
            },
          ];
    changes.push((v) => {
      v.serviceTierEvidence.snapshot.threads[0].turns[0].tier = "bad";
      v.serviceTierEvidence.sha256 = hash(JSON.stringify(v.serviceTierEvidence.snapshot));
    });
    if (version === 2)
      changes.push((v) => {
        delete v.achievements;
      });
    if (version === 1)
      changes.push((v) => {
        v.achievements = null;
      });
    for (const mutate of changes) {
      const invalid = structuredClone(manifest);
      mutate(invalid);
      writeJson(manifestFor(file), invalid);
      await assert.rejects(verifyHistoryBackup(file));
    }
    writeJson(manifestFor(file), manifest);
  }
});

test("v3 backup and bundle reject forged sidecar hashes, profiles, paths and checksum-correct rules", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.root, "invalid-sidecar.sqlite");
  const manifest = await createHistoryBackup(f.store.database, file, {
    pricingCatalog: null,
    achievementDatabaseFile: f.archiveFile,
  });
  for (const change of [
    { sha256: "0".repeat(64) },
    { profileId: "forged" },
    { schemaVersion: 3 },
    { filename: "../escape.sqlite" },
  ]) {
    writeJson(manifestFor(file), { ...manifest, achievements: { ...manifest.achievements, ...change } });
    await assert.rejects(verifyHistoryBackup(file), { code: "ACHIEVEMENT_BACKUP_INVALID" });
    const destination = path.join(f.root, "must-not-publish.sqlite");
    await assert.rejects(restoreHistoryBackup(file, destination));
    assert.equal(existsSync(destination), false);
  }
  const sidecar = path.join(f.root, manifest.achievements.filename);
  const db = new DatabaseSync(sidecar);
  try {
    db.exec("UPDATE achievement_profile SET rulesVersion = 'future'");
  } finally {
    db.close();
  }
  const bytes = readFileSync(sidecar);
  writeJson(manifestFor(file), {
    ...manifest,
    achievements: { ...manifest.achievements, bytes: bytes.length, sha256: hash(bytes) },
  });
  await assert.rejects(verifyHistoryBackup(file), {
    code: "ACHIEVEMENT_BACKUP_INVALID",
    message: "Unsupported achievement rule directory",
  });

  const bundle = path.join(f.root, "invalid-bundle");
  const published = await publishHistoryArchiveBundle(f.store.database, bundle, {
    pricingCatalog: null,
    achievementDatabaseFile: f.archiveFile,
  });
  writeJson(published.manifestFile, {
    ...published.manifest,
    achievements: { ...published.manifest.achievements, profileId: "forged" },
  });
  writeJson(published.markerFile, {
    ...published.marker,
    bundleManifestSha256: hash(readFileSync(published.manifestFile)),
  });
  await assert.rejects(verifyPublishedHistoryArchiveBundle(bundle), { code: "ACHIEVEMENT_BACKUP_INVALID" });
});

test("per-package compaction retains v1/v2/v3 price, tier and declared achievement metadata", async (t) => {
  const f = await fixture(t);
  for (const version of [1, 2, 3]) {
    const source = path.join(f.root, `candidate-${version}.sqlite`);
    await createHistoryArchiveCandidate(f.store.database, source, {
      startMs: T0,
      endMs: T0 + DAY,
      formatVersion: version,
      pricingCatalog: version === 3 ? null : { ...getPricingCatalog(), version: `per-package-${version}` },
      serviceTierSnapshot: TIER,
      ...(version === 1 ? {} : { achievementDatabaseFile: f.archiveFile }),
    });
    const before = await verifyHistoryArchiveCandidate(source);
    const destination = path.join(f.root, `compact-${version}.sqlite`);
    await compactHistoryArchivePackage(source, destination);
    const after = await verifyHistoryArchiveCandidate(destination);
    for (const key of ["formatVersion", "pricing", "pricingVersion", "pricingCheckedAt", "serviceTierEvidence"])
      assert.deepEqual(after.manifest[key], before.manifest[key]);
    if (before.manifest.achievements) {
      assert.deepEqual(
        { ...after.manifest.achievements, filename: before.manifest.achievements.filename },
        before.manifest.achievements,
      );
      assert.deepEqual(
        readFileSync(path.join(f.root, after.manifest.achievements.filename)),
        readFileSync(path.join(f.root, before.manifest.achievements.filename)),
      );
    }
  }
});

test("v3 mixed bundle transfer/import keeps each old/new package metadata and every declared sidecar", async (t) => {
  const f = await fixture(t);
  const registrations = [];
  for (const [index, version] of [2, 3].entries()) {
    const file = path.join(f.root, `segment-${version}.sqlite`);
    await createHistoryArchiveCandidate(f.store.database, file, {
      startMs: T0 + index * DAY,
      endMs: T0 + (index + 1) * DAY,
      pricingCatalog: version === 3 ? null : getPricingCatalog(),
      serviceTierSnapshot: TIER,
      achievementDatabaseFile: f.archiveFile,
    });
    const verified = await verifyHistoryArchiveCandidate(file);
    registrations.push([
      verified.manifest.database.sha256,
      file,
      verified.manifest.database.sha256,
      verified.candidate.startMs,
      verified.candidate.endMs,
      verified.candidate.events.rows,
      T0,
    ]);
  }
  for (const registration of registrations)
    f.store.database.prepare("INSERT INTO archive_segments VALUES (?, ?, ?, ?, ?, ?, ?)").run(...registration);
  const bundle = path.join(f.root, "bundle");
  const published = await publishHistoryArchiveBundle(f.store.database, bundle, {
    pricingCatalog: null,
    serviceTierSnapshot: TIER,
    achievementDatabaseFile: f.archiveFile,
  });
  assert.equal(published.manifest.formatVersion, 3);
  assert.equal(published.marker.bundleFormatVersion, 3);
  const moved = path.join(f.root, "moved");
  await stagePublishedHistoryArchiveBundle(bundle, moved);
  const imported = await publishHistoryArchiveImport(moved, path.join(f.root, "import"));
  const loaded = await loadHistoryArchiveImport(path.dirname(imported.runtimeFile));
  assert.equal(loaded.context.pricingCatalog, null);
  assert.equal(existsSync(path.join(path.dirname(imported.runtimeFile), "achievements.sqlite")), false);
  for (const [index, segment] of published.manifest.segments.entries()) {
    const before = json(path.join(bundle, segment.manifestFile));
    const after = json(path.join(loaded.bundleDirectory, segment.manifestFile));
    assert.deepEqual(after, before);
    assert.ok([2, 3].includes(after.formatVersion));
    assert.deepEqual(
      readFileSync(path.join(loaded.bundleDirectory, path.dirname(segment.databaseFile), after.achievements.filename)),
      readFileSync(path.join(bundle, path.dirname(segment.databaseFile), before.achievements.filename)),
    );
    assert.equal(index < 2, true);
  }
  const fullDir = path.join(f.root, "full-import");
  await publishHistoryArchiveImport(bundle, fullDir, {
    achievementDatabaseFile: path.join(fullDir, "achievements.sqlite"),
  });
  assert.deepEqual(
    readFileSync(path.join(fullDir, "achievements.sqlite")),
    readFileSync(path.join(bundle, published.manifest.achievements.filename)),
  );
});

test("imported contexts retain their main frozen catalog or null without loading or registering pricing", async (t) => {
  const f = await fixture(t);
  const catalog = { ...getPricingCatalog(), version: "frozen-main-catalog" };
  const before = getPricingCatalog();
  const bundles = [];
  for (const [index, pricingCatalog] of [catalog, null].entries()) {
    const bundle = path.join(f.root, `context-bundle-${index}`);
    await publishHistoryArchiveBundle(f.store.database, bundle, { pricingCatalog, serviceTierSnapshot: TIER });
    bundles.push(bundle);
  }
  const probe = createLiteBoundaryProbe(f.root, {
    forbiddenModules: [
      "src/pricing.js",
      "public/pricing-models.js",
      "src/achievement-store.js",
      "src/achievement-runtime.js",
      "src/usage-store.js",
    ],
  });
  const entry = new URL("../src/history-archive.js", import.meta.url).href;
  const script = `import assert from 'node:assert/strict'; import path from 'node:path';
    const a=await import(${JSON.stringify(entry)});
    for(const [i,bundle] of ${JSON.stringify(bundles)}.entries()) {
      const directory=path.join(${JSON.stringify(f.root)},'context-import-'+i);
      await a.publishHistoryArchiveImport(bundle,directory);
      const loaded=await a.loadHistoryArchiveImport(directory);
      assert.deepEqual(loaded.context.pricingCatalog,i===0?${JSON.stringify(catalog)}:null);
      assert.equal(loaded.context.serviceTierEvidence.resolve('session',${T0 + 1}),'priority');
    } process.stdout.write('frozen');`;
  assert.equal(
    execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      env: probe.env,
      encoding: "utf8",
      windowsHide: true,
    }),
    "frozen",
  );
  assert.equal(
    probe.read().some((entry) => entry.forbidden),
    false,
  );
  assert.deepEqual(getPricingCatalog(), before);
});

test("ban probe verifies, transfers, imports and compacts old metadata without pricing, tier logs or achievement runtime", async (t) => {
  const f = await fixture(t);
  const files = [];
  for (const version of [1, 2, 3]) {
    const file = path.join(f.root, `probe-${version}.sqlite`);
    files.push(file);
    await createHistoryArchiveCandidate(f.store.database, file, {
      startMs: T0,
      endMs: T0 + DAY,
      pricingCatalog: version === 3 ? null : getPricingCatalog(),
      serviceTierSnapshot: TIER,
      ...(version === 1 ? {} : { achievementDatabaseFile: f.archiveFile }),
    });
  }
  const bundle = path.join(f.root, "probe-bundle");
  await publishHistoryArchiveBundle(f.store.database, bundle, {
    serviceTierSnapshot: TIER,
    achievementDatabaseFile: f.archiveFile,
  });
  const original = readFileSync(f.archiveFile);
  const probe = createLiteBoundaryProbe(f.root, {
    forbiddenModules: [
      "src/pricing.js",
      "public/pricing-models.js",
      "src/service-tier-evidence.js",
      "src/achievement-backup.js",
      "src/achievement-store.js",
      "src/achievement-catalog.js",
      "src/achievement-evaluator.js",
      "src/achievement-runtime.js",
      "src/usage-store.js",
      "src/usage-core.js",
    ],
  });
  const backupEntry = new URL("../src/history-backup.js", import.meta.url).href;
  const archiveEntry = new URL("../src/history-archive.js", import.meta.url).href;
  const compactEntry = new URL("../src/history-archive-compaction.js", import.meta.url).href;
  const script = `import assert from 'node:assert/strict'; import path from 'node:path'; import {DatabaseSync} from 'node:sqlite';
    const b=await import(${JSON.stringify(backupEntry)}), a=await import(${JSON.stringify(archiveEntry)}), c=await import(${JSON.stringify(compactEntry)});
    const files=${JSON.stringify(files)}, root=${JSON.stringify(f.root)}, options={serviceTierEvidenceFormat:'snapshot'};
    for(const [i,file] of files.entries()) {
      const context=await b.loadHistoryBackupContext(file,undefined,options);
      assert.deepEqual(Object.keys(context).sort(),['databaseFile','manifestFile','pricingCatalog','serviceTierEvidence'].sort());
      assert.deepEqual(context.serviceTierEvidence,${JSON.stringify(TIER)});
      assert.equal(typeof context.serviceTierEvidence.resolve,'undefined');
      assert.equal(context.pricingCatalog===null,i===2);
      await c.compactHistoryArchivePackage(file,path.join(root,'probe-compact-'+i+'.sqlite'));
    }
    for(const invalid of [null,[],{serviceTierEvidenceFormat:'raw'}])
      await assert.rejects(b.loadHistoryBackupContext(files[0],undefined,invalid),TypeError);
    const db=new DatabaseSync(${JSON.stringify(f.store.databaseFile)},{readOnly:true});
    try {await b.createHistoryBackup(db,path.join(root,'probe-new.sqlite'),{pricingCatalog:null});
      await a.publishHistoryArchiveBundle(db,path.join(root,'probe-new-bundle'),{pricingCatalog:null});} finally {db.close();}
    await a.verifyPublishedHistoryArchiveBundle(${JSON.stringify(bundle)});
    await a.stagePublishedHistoryArchiveBundle(${JSON.stringify(bundle)},path.join(root,'probe-transfer'));
    const imported=await a.publishHistoryArchiveImport(path.join(root,'probe-transfer'),path.join(root,'probe-import'));
    assert.deepEqual((await imported.loadBundleContext(options)).serviceTierEvidence,${JSON.stringify(TIER)});
    const loaded=await a.loadHistoryArchiveImport(path.join(root,'probe-import'),options);
    assert.deepEqual(loaded.context.serviceTierEvidence,${JSON.stringify(TIER)});
    const empty=await b.loadHistoryBackupContext(path.join(root,'probe-new.sqlite'),undefined,options);
    assert.equal(empty.serviceTierEvidence,null); assert.equal(empty.pricingCatalog,null);
    const unpriced=await a.publishHistoryArchiveImport(path.join(root,'probe-new-bundle'),path.join(root,'probe-new-import'));
    assert.equal((await unpriced.loadBundleContext(options)).pricingCatalog,null);
    assert.equal((await a.loadHistoryArchiveImport(path.join(root,'probe-new-import'),options)).context.serviceTierEvidence,null);
    assert.equal((await b.verifyHistoryBackup(path.join(root,'probe-new.sqlite'))).manifest.pricing,null);
    process.stdout.write('verified');`;
  assert.equal(
    execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      env: probe.env,
      encoding: "utf8",
      windowsHide: true,
    }),
    "verified",
  );
  assert.ok(probe.read().some((entry) => entry.kind === "load" && entry.url.endsWith("achievement-backup-format.js")));
  assert.equal(
    probe.read().some((entry) => entry.forbidden),
    false,
  );
  assert.deepEqual(readFileSync(f.archiveFile), original);
  assert.ok(readdirSync(f.root).includes("probe-import"));
});
