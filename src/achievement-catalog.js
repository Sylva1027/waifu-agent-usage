// Approved R7 IDs, tiers and thresholds. No sample progress or authoring dependencies.
export const ACHIEVEMENT_RULES_VERSION = "R7-production-2";
export const ACHIEVEMENT_CATALOG = Object.freeze(
  [
    {
      id: "A01",
      tiers: ["bronze", "silver", "gold"],
      thresholds: ["50000000000", "200000000000", "5000000000000"],
    },
    {
      id: "A06",
      tiers: ["bronze", "silver", "gold"],
      thresholds: ["10000000000", "100000000000", "1000000000000"],
    },
    {
      id: "A07",
      tiers: ["bronze", "silver", "gold"],
      thresholds: ["10", "30", "50"],
    },
    {
      id: "A08",
      tiers: ["bronze", "silver", "gold"],
      thresholds: ["3", "5", "10"],
    },
    {
      id: "A09",
      tiers: ["bronze", "silver", "gold"],
      thresholds: ["2", "4", "7"],
    },
    {
      id: "A10",
      tiers: ["bronze", "silver", "gold"],
      thresholds: ["3", "7", "15"],
    },
    {
      id: "A11",
      tiers: ["bronze", "silver", "gold"],
      thresholds: ["2", "4", "6"],
    },
    {
      id: "A12",
      tiers: ["bronze", "silver", "gold"],
      thresholds: ["5", "7", "12"],
    },
    {
      id: "A13",
      tiers: ["bronze", "silver", "gold"],
      thresholds: ["30", "180", "365"],
    },
    {
      id: "A14",
      tiers: ["bronze", "silver", "gold"],
      thresholds: ["7", "30", "365"],
    },
    {
      id: "A16",
      tiers: ["bronze", "silver", "gold"],
      thresholds: ["3", "12", "24"],
    },
    {
      id: "A18",
      tiers: ["bronze", "silver", "gold"],
      thresholds: ["30", "90", "180"],
    },
    {
      id: "A19",
      tiers: ["bronze", "silver", "gold"],
      thresholds: ["100000000", "1000000000", "10000000000"],
    },
    {
      id: "A23",
      tiers: ["bronze", "silver", "gold"],
      thresholds: ["500000000", "1000000000", "5000000000"],
    },
    {
      id: "A24",
      tiers: ["bronze", "silver", "gold"],
      thresholds: ["5", "10", "30"],
    },
    {
      id: "A28",
      tiers: ["bronze", "silver", "gold"],
      thresholds: ["4", "7", "10"],
    },
    {
      id: "A29",
      tiers: ["bronze", "silver", "gold"],
      thresholds: ["3", "5", "7"],
    },
    {
      id: "A30",
      tiers: ["bronze", "silver", "gold"],
      thresholds: ["7", "15", "45"],
    },
    {
      id: "A31",
      tiers: ["stone"],
      thresholds: ["1"],
    },
    {
      id: "A32",
      tiers: ["stone"],
      thresholds: ["10000000000"],
    },
    {
      id: "A33",
      tiers: ["stone"],
      thresholds: ["2"],
    },
    {
      id: "A36",
      tiers: ["stone"],
      thresholds: ["30"],
    },
    {
      id: "A38",
      tiers: ["stone"],
      thresholds: ["1"],
    },
    {
      id: "A39",
      tiers: ["stone"],
      thresholds: ["1"],
    },
    {
      id: "A43",
      tiers: ["bronze", "silver", "gold"],
      thresholds: ["1", "10", "50"],
    },
    {
      id: "A44",
      tiers: ["stone"],
      thresholds: ["8"],
    },
    {
      id: "A46",
      tiers: ["stone"],
      thresholds: ["1"],
    },
    {
      id: "A53",
      tiers: ["bronze", "silver", "gold"],
      thresholds: ["1000000000", "5000000000", "15000000000"],
    },
    {
      id: "A54",
      tiers: ["bronze", "silver", "gold"],
      thresholds: ["10000000000", "200000000000", "1000000000000"],
    },
    {
      id: "A55",
      tiers: ["bronze", "silver", "gold"],
      thresholds: ["1000000000", "50000000000", "1000000000000"],
    },
    {
      id: "A56",
      tiers: ["bronze", "silver", "gold"],
      thresholds: ["5", "10", "30"],
    },
    {
      id: "A58",
      tiers: ["bronze", "silver", "gold"],
      thresholds: ["3000000000", "10000000000", "100000000000"],
    },
    {
      id: "A59",
      tiers: ["bronze", "silver", "gold"],
      thresholds: ["1000000000", "3000000000", "10000000000"],
    },
    {
      id: "A63",
      tiers: ["bronze", "silver", "gold"],
      thresholds: ["3", "5", "7"],
    },
    {
      id: "A65",
      tiers: ["bronze", "silver", "gold"],
      thresholds: ["3", "6", "12"],
    },
    {
      id: "A69",
      tiers: ["stone"],
      thresholds: ["100000000000"],
    },
    {
      id: "A70",
      tiers: ["stone"],
      thresholds: ["1000000000000"],
    },
    {
      id: "A71",
      tiers: ["stone"],
      thresholds: ["10000000000000"],
    },
    {
      id: "A73",
      tiers: ["stone"],
      thresholds: ["27"],
    },
    {
      id: "A74",
      tiers: ["stone"],
      thresholds: ["27"],
    },
    {
      id: "A75",
      tiers: ["stone"],
      thresholds: ["27"],
    },
    {
      id: "A76",
      tiers: ["stone"],
      thresholds: ["11"],
    },
  ].map((row) => Object.freeze({ ...row, tiers: Object.freeze(row.tiers), thresholds: Object.freeze(row.thresholds) })),
);
