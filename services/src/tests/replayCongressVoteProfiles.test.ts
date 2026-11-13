import type { RawBill } from "../models/bill";
import {
  buildS3WrappedObjectMessage,
  computeCurrentCongressNumber,
  processedBillNeedsVoteProfileReplay,
  rawBillNeedsVoteEnrichmentReplay,
} from "../shared/replayCongressVoteProfiles";

/** The fixtures below carry only the fields the replay check reads. */
const partialRawBill = (fields: Pick<RawBill, "identifier" | "content">): RawBill => fields as RawBill;

describe("replayCongressVoteProfiles helpers", () => {
  it("computes the current congress around term boundaries", () => {
    expect(computeCurrentCongressNumber(new Date("2025-01-02T12:00:00.000Z"))).toBe(118);
    expect(computeCurrentCongressNumber(new Date("2025-01-04T12:00:00.000Z"))).toBe(119);
    expect(computeCurrentCongressNumber(new Date("2026-03-16T12:00:00.000Z"))).toBe(119);
  });

  it("detects raw bills that still need senate member vote enrichment", () => {
    const rawBill = partialRawBill({
      identifier: { congress: "119", billType: "s", billNumber: "25" },
      content: {
        actions: {
          actions: [
            {
              actionCode: "17000",
              actionDate: "2026-02-11",
              text: "Passed Senate by Yea-Nay Vote. 60 - 40. Roll Call No. 51.",
            },
          ],
        },
        officialVotes: {
          senate: {
            memberDataAvailable: false,
            members: [],
          },
        },
      },
    });

    expect(rawBillNeedsVoteEnrichmentReplay(rawBill)).toBe(true);
  });

  it("replays raw bills with procedural Senate vote actions even before a roll call ref is extractable", () => {
    const rawBill = partialRawBill({
      identifier: { congress: "119", billType: "s", billNumber: "3627" },
      content: {
        actions: {
          actions: [
            {
              actionDate: "2026-01-15",
              text: "Cloture motion on the motion to proceed presented in Senate. (CR S262)",
            },
          ],
        },
        officialVotes: {
          senate: {
            memberDataAvailable: false,
            members: [],
          },
        },
      },
    });

    expect(rawBillNeedsVoteEnrichmentReplay(rawBill)).toBe(true);
  });

  it("skips raw bills that only have House voice-vote actions", () => {
    const rawBill = partialRawBill({
      identifier: { congress: "119", billType: "hr", billNumber: "183" },
      content: {
        actions: {
          actions: [
            {
              actionDate: "2025-07-21",
              text: "On motion to suspend the rules and pass the bill, as amended Agreed to by voice vote. (text: CR H3496)",
            },
            {
              actionDate: "2025-07-21",
              text: "Passed/agreed to in House: On motion to suspend the rules and pass the bill, as amended Agreed to by voice vote. (text: CR H3496)",
            },
          ],
        },
      },
    });

    expect(rawBillNeedsVoteEnrichmentReplay(rawBill)).toBe(false);
  });

  it("skips raw bills that only have Senate unanimous-consent passage", () => {
    const rawBill = partialRawBill({
      identifier: { congress: "119", billType: "s", billNumber: "723" },
      content: {
        actions: {
          actions: [
            {
              actionDate: "2025-12-11",
              sourceSystem: { name: "Senate" },
              text: "Passed Senate without amendment by Unanimous Consent. (consideration: CR S8689-8691; text: CR S8689-8691)",
            },
            {
              actionCode: "17000",
              actionDate: "2025-12-11",
              sourceSystem: { code: 9, name: "Library of Congress" },
              text: "Passed/agreed to in Senate: Passed Senate without amendment by Unanimous Consent.",
            },
          ],
        },
      },
    });

    expect(rawBillNeedsVoteEnrichmentReplay(rawBill)).toBe(false);
  });

  it("skips raw bills whose chamber member data is already attached", () => {
    const rawBill = partialRawBill({
      identifier: { congress: "119", billType: "hr", billNumber: "1" },
      content: {
        actions: {
          actions: [
            {
              actionCode: "8000",
              actionDate: "2026-01-12",
              text: "Passed House by the Yeas and Nays: 220 - 210 (Roll no. 12).",
            },
          ],
        },
        officialVotes: {
          house: {
            memberDataAvailable: true,
            members: [{ bioguideId: "A000001", votePosition: "Yea" }],
          },
        },
      },
    });

    expect(rawBillNeedsVoteEnrichmentReplay(rawBill)).toBe(false);
  });

  it("detects processed bills that can replay member vote profiles", () => {
    const processedBill = {
      civicProfile: {
        individualVsCommunity: 0.6,
      },
      officialVotes: {
        senate: {
          members: [
            { bioguideId: "S000001", votePosition: "Yea" },
            { bioguideId: "S000002", votePosition: "Present" },
          ],
        },
      },
    };

    expect(processedBillNeedsVoteProfileReplay(processedBill)).toBe(true);
  });

  it("skips processed bills without civic profile scores or yea/nay members", () => {
    expect(
      processedBillNeedsVoteProfileReplay({
        officialVotes: {
          house: {
            members: [{ bioguideId: "A000001", votePosition: "Yea" }],
          },
        },
      }),
    ).toBe(false);

    expect(
      processedBillNeedsVoteProfileReplay({
        civicProfile: { individualVsCommunity: 0.6 },
        officialVotes: {
          senate: {
            members: [{ bioguideId: "S000001", votePosition: "Present" }],
          },
        },
      }),
    ).toBe(false);
  });

  it("builds s3-wrapped messages for the congress member stats queue", () => {
    const parsed = JSON.parse(
      buildS3WrappedObjectMessage("billboard-bill-store-bucket", "processed-bills/BILLS-119s25.json"),
    );

    expect(parsed).toEqual({
      Records: [
        {
          s3: {
            bucket: { name: "billboard-bill-store-bucket" },
            object: { key: "processed-bills/BILLS-119s25.json" },
          },
        },
      ],
    });
  });
});
