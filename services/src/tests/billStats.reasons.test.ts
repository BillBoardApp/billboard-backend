import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { createBillStatsAccumulator, toServedStats, withCountedReasons } from "../shared/billStats";
import type { BillStatsResponse } from "../shared/billStats";

// UX-39k (a project decision, 2026-11-23): Need More Information contradicts a Yea or Nay, so it is never
// counted in their reason breakdown, from any build; app 1.2 and later offer it only with an Abstain, whose
// reasons are counted nowhere. The vote itself still counts, and the reason stays stored on the row.

type Row = Record<string, AttributeValue>;

const vote = (feedback: string, reasons?: string[]): Row => ({
  feedback: { S: feedback },
  constituentVerified: { BOOL: false },
  ...(reasons ? { reasons: { SS: reasons } } : {}),
});

/** The stats of `rows`, folded as billStatsAggregator and GET /bill-stats fold them (minCount 5). */
const fold = (rows: Row[]): BillStatsResponse => {
  const accumulator = createBillStatsAccumulator("BILLS-119hr1");
  for (const row of rows) accumulator.add(row);
  return accumulator.result();
};
const times = (count: number, row: Row): Row[] => Array.from({ length: count }, () => row);

describe("Need More Information in the Yea and Nay reason counts (UX-39k)", () => {
  it("counts a Yea or Nay that gives it, but not the reason", () => {
    const stats = fold([
      ...times(5, vote("Yea", ["need_more_info", "economic_impact"])),
      ...times(6, vote("Nay", ["need_more_info"])),
    ]);

    expect(stats.totals).toMatchObject({ votes: 11, yea: 5, nay: 6, abstain: 0 });
    expect(stats.reasonBreakdown).toEqual({
      minCount: 5,
      yea: { voteCount: 5, reasons: [{ reasonKey: "economic_impact", count: 5, pct: 100 }] },
      nay: { voteCount: 6, reasons: [] },
    });
  });

  it("leaves it out with spaces around it too, as the fold trims every reason", () => {
    const stats = fold(times(5, vote("Yea", [" need_more_info "])));

    expect(stats.reasonBreakdown.yea).toEqual({ voteCount: 5, reasons: [] });
  });

  it("counts an Abstain that gives it as an Abstain, and its reasons nowhere", () => {
    const stats = fold(times(5, vote("Abstain", ["need_more_info", "economic_impact"])));

    expect(stats.totals).toMatchObject({ votes: 5, yea: 0, nay: 0, abstain: 5 });
    expect(stats.reasonBreakdown).toEqual({
      minCount: 5,
      yea: { voteCount: 0, reasons: [] },
      nay: { voteCount: 0, reasons: [] },
    });
    expect(JSON.stringify(stats)).not.toContain("need_more_info");
  });

  it("counts every other reason as before: the same counts, order, floor and percentages", () => {
    const rows = [
      ...times(6, vote("Yea", ["economic_impact", "healthcare"])),
      ...times(2, vote("Yea", ["healthcare", "need_more_info"])),
      ...times(4, vote("Yea", ["education"])),
      ...times(5, vote("Nay", ["taxes_spending", "need_more_info"])),
      vote("Nay"),
    ];
    const withoutIt = rows.map((row) =>
      row.reasons ? { ...row, reasons: { SS: row.reasons.SS!.filter((r) => r !== "need_more_info") } } : row,
    );

    const stats = fold(rows);

    expect(stats.reasonBreakdown).toEqual({
      minCount: 5,
      yea: {
        voteCount: 12,
        reasons: [
          { reasonKey: "healthcare", count: 8, pct: 66.6667 },
          { reasonKey: "economic_impact", count: 6, pct: 50 },
        ],
      },
      nay: { voteCount: 6, reasons: [{ reasonKey: "taxes_spending", count: 5, pct: 83.3333 }] },
    });
    expect(stats.reasonBreakdown).toEqual(fold(withoutIt).reasonBreakdown);
  });

  describe("a stats document stored before the fold left it out", () => {
    const stored = (): BillStatsResponse => {
      const stats = fold([...times(10, vote("Yea", ["economic_impact"])), ...times(5, vote("Nay", ["healthcare"]))]);
      stats.reasonBreakdown.yea.reasons = [
        { reasonKey: "economic_impact", count: 10, pct: 100 },
        { reasonKey: "need_more_info", count: 6, pct: 60 },
      ];
      stats.reasonBreakdown.nay.reasons = [
        { reasonKey: "need_more_info", count: 5, pct: 100 },
        { reasonKey: "healthcare", count: 5, pct: 100 },
      ];
      return stats;
    };

    it("is served without it, with every vote and every other reason as stored", () => {
      const document = stored();

      const servedStats = toServedStats(document);

      expect(servedStats.reasonBreakdown).toEqual({
        minCount: 5,
        yea: { voteCount: 10, reasons: [{ reasonKey: "economic_impact", count: 10, pct: 100 }] },
        nay: { voteCount: 5, reasons: [{ reasonKey: "healthcare", count: 5, pct: 100 }] },
      });
      expect(servedStats.totals).toEqual(document.totals);
      expect(servedStats.comparison?.allUsers).toMatchObject({ votes: 15, yea: 10, nay: 5 });
      // The document itself is left as it is: nothing stored is rewritten.
      expect(document.reasonBreakdown.yea.reasons).toHaveLength(2);
    });

    it("is filtered the same way twice, and a document without a breakdown is left alone", () => {
      const once = withCountedReasons(stored());

      expect(withCountedReasons(once)).toEqual(once);
      const bare = { billId: "BILLS-119hr1" } as unknown as BillStatsResponse;
      expect(withCountedReasons(bare)).toBe(bare);
      const malformed = {
        ...stored(),
        reasonBreakdown: { minCount: 5, yea: { voteCount: 1 }, nay: null },
      } as unknown as BillStatsResponse;
      expect(withCountedReasons(malformed).reasonBreakdown).toEqual(malformed.reasonBreakdown);
    });
  });
});
