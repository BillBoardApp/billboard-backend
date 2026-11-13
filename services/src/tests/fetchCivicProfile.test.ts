jest.mock("@aws-sdk/client-dynamodb", () => {
  const actual = jest.requireActual("@aws-sdk/client-dynamodb");
  const mockSend = jest.fn();
  return {
    ...actual,
    DynamoDBClient: jest.fn(() => ({ send: mockSend })),
    __mockSend: mockSend,
  };
});

process.env.TABLE_NAME = "UserBillFeedback";
process.env.PARTITION_KEY = "user_id";
process.env.SORT_KEY = "bill_id";
process.env.MANIFEST_TABLE_NAME = "BillsManifest";
process.env.MANIFEST_PRIMARY_KEY = "pk";
process.env.MANIFEST_SORT_KEY = "sk";
process.env.MANIFEST_GUID_LOOKUP_PK = "BILL_GUID";

import { readFileSync } from "fs";
import { join } from "path";

const { __mockSend: mockSend } = jest.requireMock("@aws-sdk/client-dynamodb");
const { handler } = require("../handlers/fetchCivicProfile");
const {
  computeMemberCivicProfile,
  MEMBER_CIVIC_PROFILE_MIN_AXIS_WEIGHTED_EVIDENCE,
} = require("../shared/memberCivicProfile");

describe("fetchCivicProfile handler", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns 401 when unauthenticated", async () => {
    const response = await handler({});
    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body)).toEqual({ message: "Unauthorized" });
  });

  it("treats abstain as non-voted before applying the rolling window", async () => {
    const start = new Date("2026-06-30T00:00:00.000Z");
    const items: Array<Record<string, unknown>> = [];

    for (let i = 0; i < 120; i += 1) {
      const d = new Date(start);
      d.setUTCDate(start.getUTCDate() - i);
      const isAbstain = i < 100;

      items.push({
        feedback: { S: isAbstain ? "Abstain" : "Yea" },
        votedAt: { S: d.toISOString() },
        civicProfile: {
          M: {
            individualVsCommunity: { N: isAbstain ? "1.0" : "0.6" },
          },
        },
      });
    }

    mockSend.mockResolvedValueOnce({ Items: items });

    const response = await handler({
      requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);

    expect(body.totalVotesWithProfile).toBe(20);
    expect(body.votesUsed).toBe(20);
    expect(body.isReady).toBe(false);
    // 20 votes on one theme: the 3rd theme is 8 votes short, more than the votes' 5 (UX-32), so 8 more.
    expect(body.minVotesRequired).toBe(28);
    expect(body.lockedBy).toBe("themes");
    expect(body.axes.individualVsCommunity).toBeCloseTo(0.8, 6);

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          ProjectionExpression: "feedback, votedAt, civicProfile, #sk, #legacyDismiss",
          ExpressionAttributeNames: { "#pk": "user_id", "#sk": "bill_id", "#legacyDismiss": "legacyDismiss" },
        }),
      }),
    );
  });

  it("falls back to manifest metadata when legacy vote rows are missing civicProfile", async () => {
    mockSend
      .mockResolvedValueOnce({
        Items: [
          {
            bill_id: { S: "BILLS-119hr1" },
            feedback: { S: "Yea" },
            votedAt: { S: "2026-04-01T00:00:00.000Z" },
          },
        ],
      })
      .mockResolvedValueOnce({
        Item: {
          manifestSk: { S: "2026-03-31T00:00:00.000Z#BILLS-119hr1" },
        },
      })
      .mockResolvedValueOnce({
        Item: {
          civicProfile: {
            M: {
              individualVsCommunity: { N: "0.2" },
            },
          },
        },
      });

    const response = await handler({
      requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);

    expect(body.totalVotesWithProfile).toBe(1);
    expect(body.votesUsed).toBe(1);
    // One vote is below the per-theme floor of 8, so the theme is not scored yet.
    expect(body.axes).toEqual({});

    expect(mockSend).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        input: expect.objectContaining({
          TableName: "BillsManifest",
          Key: {
            pk: { S: "BILL_GUID" },
            sk: { S: "BILLS-119hr1" },
          },
          ProjectionExpression: "manifestSk",
        }),
      }),
    );
    expect(mockSend).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        input: expect.objectContaining({
          TableName: "BillsManifest",
          Key: {
            pk: { S: "BILL" },
            sk: { S: "2026-03-31T00:00:00.000Z#BILLS-119hr1" },
          },
          ProjectionExpression: "civicProfile",
        }),
      }),
    );
  });

  describe("per-theme floor of 8 votes and readiness (UX-32)", () => {
    const at = (minute: number) => new Date(Date.UTC(2026, 4, 1) + minute * 60_000).toISOString();
    const vote = (feedback: string, minute: number, civicProfile: Record<string, string>) => ({
      feedback: { S: feedback },
      votedAt: { S: at(minute) },
      civicProfile: { M: Object.fromEntries(Object.entries(civicProfile).map(([axis, n]) => [axis, { N: n }])) },
    });
    // `count` Yea or Nay votes on bills scored only on `axes` (one theme, or several: a bill counts for each), each
    // pulling the same way: a Yea on 0.5 or, every fourth vote, a Nay on -0.5. Their average is 0.5, which is 0.75 once
    // normalized.
    const themeVotes = (count: number, axes: string | string[], from = 0) =>
      Array.from({ length: count }, (_, i) => {
        const scored = (score: string) => Object.fromEntries([axes].flat().map((axis) => [axis, score]));
        return i % 4 === 3 ? vote("Nay", from + i, scored("-0.5")) : vote("Yea", from + i, scored("0.5"));
      });
    // The UX-32 fields of a body, beside the five both apps decode.
    const locked = (lockedBy: "votes" | "themes", themesReady: number) => ({
      isReady: false,
      lockedBy,
      themesReady,
      minThemesRequired: 3,
      minThemeVotes: 8,
    });
    const ready = (themesReady: number) => ({
      isReady: true,
      lockedBy: null,
      themesReady,
      minThemesRequired: 3,
      minThemeVotes: 8,
    });

    const run = async (items: Array<Record<string, unknown>>) => {
      mockSend.mockResolvedValueOnce({ Items: items });
      const response = await handler({ requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } } });
      expect(response.statusCode).toBe(200);
      return JSON.parse(response.body);
    };

    it("answers the five fields both apps decode and the four UX-32 fields, as the contract lists them", async () => {
      const body = await run(themeVotes(3, "privacyVsSecurity"));

      const openapi = JSON.parse(readFileSync(join(__dirname, "../../../contracts/openapi/user-api.v1.json"), "utf8"));
      const schema = openapi.components.schemas.UserCivicProfile;
      expect(Object.keys(body).sort()).toEqual(Object.keys(schema.properties).sort());
      expect(schema.required).toEqual(["axes", "votesUsed", "totalVotesWithProfile", "minVotesRequired", "isReady"]);
    });

    it("leaves out a theme with 7 Yea or Nay votes; Abstains on it do not count", async () => {
      const body = await run([
        ...themeVotes(7, "traditionalVsProgressive"),
        vote("Abstain", 7, { traditionalVsProgressive: "0.5" }),
        vote("Abstain", 8, { traditionalVsProgressive: "0.5" }),
      ]);

      expect(body).toEqual({
        axes: {},
        votesUsed: 7,
        totalVotesWithProfile: 7,
        minVotesRequired: 25,
        ...locked("votes", 0),
      });
    });

    it("returns a theme at 8 Yea or Nay votes", async () => {
      const body = await run(themeVotes(8, "traditionalVsProgressive"));

      expect(body.axes).toEqual({ traditionalVsProgressive: 0.75 });
      expect(body.votesUsed).toBe(8);
      expect(body.themesReady).toBe(1);
    });

    it("returns a theme at 9 votes, averaging all nine", async () => {
      const body = await run([
        ...themeVotes(8, "traditionalVsProgressive"),
        vote("Nay", 8, { traditionalVsProgressive: "0.5" }),
      ]);

      expect(Object.keys(body.axes)).toEqual(["traditionalVsProgressive"]);
      // (8 x 0.5 - 0.5) / 9 = 0.3889 -> normalized (0.3889 + 1) / 2
      expect(body.axes.traditionalVsProgressive).toBeCloseTo(0.6944, 4);
      expect(body.votesUsed).toBe(9);
    });

    it("counts a zero score as evidence for that theme", async () => {
      const body = await run(
        Array.from({ length: 8 }, (_, i) => vote(i < 5 ? "Yea" : "Nay", i, { privacyVsSecurity: "0" })),
      );

      expect(body.axes).toEqual({ privacyVsSecurity: 0.5 });
    });

    it("keeps a user under 25 votes locked on the votes, as before, even with 3 themes at 8", async () => {
      // 24 votes on bills scored on three themes: each theme has 24.
      const body = await run(themeVotes(24, ["individualVsCommunity", "localVsFederal", "privacyVsSecurity"]));

      expect(body).toEqual({
        axes: { individualVsCommunity: 0.75, localVsFederal: 0.75, privacyVsSecurity: 0.75 },
        votesUsed: 24,
        totalVotesWithProfile: 24,
        minVotesRequired: 25,
        ...locked("votes", 3),
      });
    });

    it("keeps a user under 25 votes locked, with the same shape, when every theme is under the floor", async () => {
      const body = await run([
        ...themeVotes(4, "individualVsCommunity"),
        ...themeVotes(4, "localVsFederal", 4),
        ...themeVotes(3, "freeMarketVsRegulated", 8),
        ...themeVotes(3, "traditionalVsProgressive", 11),
        ...themeVotes(3, "interventionistVsRestrained", 14),
        ...themeVotes(3, "privacyVsSecurity", 17),
      ]);

      // The votes and the 3rd theme (3 votes) are both 5 short: a tie names the votes.
      expect(body).toEqual({
        axes: {},
        votesUsed: 20,
        totalVotesWithProfile: 20,
        minVotesRequired: 25,
        ...locked("votes", 0),
      });
    });

    it("asks a user under 25 votes for the 3rd theme's shortfall when it is larger, so N does not jump at 25", async () => {
      // 24 votes on one theme: 1 vote short of 25, but the 3rd theme is 8 short, so "Vote on 8 more bills" (32 - 24);
      // at 25 votes still 8 (33 - 25). Before, it asked for 1, then 8.
      const atTwentyFour = await run(themeVotes(24, "privacyVsSecurity"));
      expect(atTwentyFour).toEqual({
        axes: { privacyVsSecurity: 0.75 },
        votesUsed: 24,
        totalVotesWithProfile: 24,
        minVotesRequired: 32,
        ...locked("themes", 1),
      });
      const atTwentyFive = await run(themeVotes(25, "privacyVsSecurity"));
      expect(atTwentyFive).toMatchObject({ votesUsed: 25, minVotesRequired: 33, ...locked("themes", 1) });
    });

    it("keeps 25 or more votes locked with no theme at 8, asking for the 3rd theme's shortfall", async () => {
      const axes = [
        "individualVsCommunity",
        "localVsFederal",
        "freeMarketVsRegulated",
        "traditionalVsProgressive",
        "interventionistVsRestrained",
        "privacyVsSecurity",
      ];
      // 42 votes, 7 on each theme: the chart would have no shape. One more vote on a bill scored on three themes
      // could unlock it, so "Vote on 1 more bill" (43 - 42).
      const body = await run(axes.flatMap((axis, index) => themeVotes(7, axis, index * 7)));

      expect(body).toEqual({
        axes: {},
        votesUsed: 42,
        totalVotesWithProfile: 42,
        minVotesRequired: 43,
        ...locked("themes", 0),
      });
    });

    it("asks for 8 more votes when fewer than 3 themes have any", async () => {
      const body = await run(themeVotes(30, "privacyVsSecurity"));

      expect(body).toEqual({
        axes: { privacyVsSecurity: 0.75 },
        votesUsed: 30,
        totalVotesWithProfile: 30,
        minVotesRequired: 38,
        ...locked("themes", 1),
      });
    });

    it("keeps 25 votes with 1 theme at 8 locked, the 3rd theme at 5 short by 3", async () => {
      const body = await run([
        ...themeVotes(10, "individualVsCommunity"),
        ...themeVotes(6, "localVsFederal", 10),
        ...themeVotes(5, "freeMarketVsRegulated", 16),
        ...themeVotes(4, "privacyVsSecurity", 21),
      ]);

      expect(body).toEqual({
        axes: { individualVsCommunity: 0.75 },
        votesUsed: 25,
        totalVotesWithProfile: 25,
        minVotesRequired: 28,
        ...locked("themes", 1),
      });
    });

    it("keeps 25 votes with 2 themes at 8 and the 3rd at 7 locked: 1 more vote", async () => {
      const body = await run([
        // A bill scored on two themes counts for each.
        ...Array.from({ length: 8 }, (_, i) =>
          vote("Yea", i, { individualVsCommunity: "0.5", localVsFederal: "-0.25" }),
        ),
        ...themeVotes(7, "freeMarketVsRegulated", 8),
        ...themeVotes(5, "traditionalVsProgressive", 15),
        // Three votes: enough under the old floor, not under this one.
        ...themeVotes(3, "interventionistVsRestrained", 20),
        ...themeVotes(2, "privacyVsSecurity", 23),
      ]);

      expect(body).toEqual({
        axes: { individualVsCommunity: 0.75, localVsFederal: 0.375 },
        votesUsed: 25,
        totalVotesWithProfile: 25,
        minVotesRequired: 26,
        ...locked("themes", 2),
      });
    });

    it("unlocks at 25 votes once the 3rd theme reaches 8, and stays unlocked at 9", async () => {
      // 17 votes: 8 on bills scored on two themes, then 5 and 4 on two more.
      const base = [
        ...themeVotes(8, ["individualVsCommunity", "localVsFederal"]),
        ...themeVotes(5, "interventionistVsRestrained", 8),
        ...themeVotes(4, "freeMarketVsRegulated", 13),
      ];
      const atSeven = await run([
        ...base,
        ...themeVotes(7, "privacyVsSecurity", 17),
        ...themeVotes(1, "freeMarketVsRegulated", 24),
      ]);
      const atEight = await run([...base, ...themeVotes(8, "privacyVsSecurity", 17)]);
      const atNine = await run([...base, ...themeVotes(9, "privacyVsSecurity", 17)]);

      // 25 votes, the 3rd theme at 7: one more vote on it could unlock the profile.
      expect(atSeven).toEqual({
        axes: { individualVsCommunity: 0.75, localVsFederal: 0.75 },
        votesUsed: 25,
        totalVotesWithProfile: 25,
        minVotesRequired: 26,
        ...locked("themes", 2),
      });
      expect(atEight).toEqual({
        axes: { individualVsCommunity: 0.75, localVsFederal: 0.75, privacyVsSecurity: 0.75 },
        votesUsed: 25,
        totalVotesWithProfile: 25,
        minVotesRequired: 25,
        ...ready(3),
      });
      expect(atNine).toMatchObject({ votesUsed: 26, minVotesRequired: 25, ...ready(3) });
      expect(Object.keys(atNine.axes)).toEqual(["individualVsCommunity", "localVsFederal", "privacyVsSecurity"]);
    });

    it("is ready with 3 themes at 8 from 25 votes on bills each scored on all three", async () => {
      const body = await run(themeVotes(25, ["localVsFederal", "freeMarketVsRegulated", "privacyVsSecurity"]));

      expect(body).toEqual({
        axes: { localVsFederal: 0.75, freeMarketVsRegulated: 0.75, privacyVsSecurity: 0.75 },
        votesUsed: 25,
        totalVotesWithProfile: 25,
        minVotesRequired: 25,
        ...ready(3),
      });
    });

    it("counts a theme's votes among the same last 100 votes as votesUsed", async () => {
      const body = await run([
        // Nine votes on privacyVsSecurity, the oldest two outside the last 100.
        ...themeVotes(9, "privacyVsSecurity"),
        ...themeVotes(93, ["individualVsCommunity", "localVsFederal"], 9),
      ]);

      expect(body.totalVotesWithProfile).toBe(102);
      expect(body.votesUsed).toBe(100);
      expect(body.axes).toEqual({ individualVsCommunity: 0.75, localVsFederal: 0.75 });
      // The 3rd theme has 7 in the window: past the 100-vote cap minVotesRequired exceeds 100, so both apps still ask
      // for 1 more vote ("100 / 101 votes" in 1.1, "100 of 101 votes" in 1.2).
      expect(body).toMatchObject({ minVotesRequired: 101, ...locked("themes", 2) });
    });

    it("at the 100-vote cap, is ready only from the themes of the last 100 votes", async () => {
      const older = themeVotes(20, "traditionalVsProgressive");
      const recent = themeVotes(100, ["individualVsCommunity", "localVsFederal"], 20);
      const lockedAtCap = await run([...older, ...recent]);
      expect(lockedAtCap).toMatchObject({
        votesUsed: 100,
        totalVotesWithProfile: 120,
        minVotesRequired: 108,
        ...locked("themes", 2),
      });
      expect(lockedAtCap.axes).toEqual({ individualVsCommunity: 0.75, localVsFederal: 0.75 });

      const readyAtCap = await run([
        ...older,
        ...themeVotes(100, ["individualVsCommunity", "localVsFederal", "privacyVsSecurity"], 20),
      ]);
      expect(readyAtCap).toMatchObject({ votesUsed: 100, minVotesRequired: 25, ...ready(3) });
    });

    it("leaves members' floor at 3: votes that give a member a theme do not give you one", async () => {
      expect(MEMBER_CIVIC_PROFILE_MIN_AXIS_WEIGHTED_EVIDENCE).toBe(3);
      const member = computeMemberCivicProfile(
        [0, 1, 2].map((minute) => ({
          billGuid: `BILLS-119hr${minute + 1}`,
          evidenceType: "voteYea" as const,
          occurredAt: at(minute),
          civicProfile: { privacyVsSecurity: 0.5 },
        })),
      );
      expect(member.axes).toEqual({ privacyVsSecurity: 0.75 });

      const body = await run([0, 1, 2].map((minute) => vote("Yea", minute, { privacyVsSecurity: "0.5" })));
      expect(body.axes).toEqual({});
    });
  });
});

export {};

describe("fetchCivicProfile companion groups (APPF-23)", () => {
  const vote = (billId: string, feedback: string, day: number, score: string) => ({
    bill_id: { S: billId },
    feedback: { S: feedback },
    votedAt: { S: `2026-05-${String(day).padStart(2, "0")}T00:00:00.000Z` },
    civicProfile: { M: { individualVsCommunity: { N: score } } },
  });
  const groupsRow = (enabled: boolean) => ({
    Item: {
      pk: { S: "BILL_COMPANION_GROUPS" },
      sk: { S: "CURRENT" },
      pairsVersion: { N: "3" },
      enabled: { BOOL: enabled },
      pairs: {
        S: JSON.stringify([
          ["BILLS-119hr1285", "BILLS-119s570"],
          ["BILLS-119hr2000", "BILLS-119s1000"],
        ]),
      },
    },
  });
  let profileHandler: (event: unknown) => Promise<{ statusCode: number; body: string }>;
  let send: jest.Mock;

  beforeEach(() => {
    jest.resetModules();
    ({ __mockSend: send } = jest.requireMock("@aws-sdk/client-dynamodb"));
    profileHandler = require("../handlers/fetchCivicProfile").handler;
  });

  const profileFor = async (items: unknown[], enabled = true) => {
    send.mockImplementation(async (command: { input?: { Key?: { pk?: { S?: string } } } }) =>
      command.input?.Key?.pk?.S === "BILL_COMPANION_GROUPS" ? groupsRow(enabled) : { Items: items },
    );
    const response = await profileHandler({ requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } } });
    expect(response.statusCode).toBe(200);
    return JSON.parse(response.body);
  };

  // Five votes on bills in no group, at the average the cases below expect (0.5), so the theme reaches the
  // per-theme floor of 8 (UX-32) and is returned.
  const otherVotes = [5, 6, 7, 8, 9].map((day) => vote(`BILLS-119hr90${day}`, "Yea", day, "0.5"));
  const votes = [
    // Both members of one pair: the House row counts, once (the Senate Nay would cancel it out).
    vote("BILLS-119hr1285", "Yea", 1, "0.8"),
    vote("BILLS-119s570", "Nay", 2, "0.8"),
    // The Senate member only: it still counts.
    vote("BILLS-119s1000", "Yea", 3, "0.2"),
    vote("BILLS-119hr77", "Yea", 4, "0.5"),
    ...otherVotes,
  ];

  it("counts a user with votes on both members once (the House row) and a partner-only vote once", async () => {
    const body = await profileFor(votes);

    expect(body.totalVotesWithProfile).toBe(8);
    expect(body.votesUsed).toBe(8);
    // (0.8 + 0.2 + 0.5 + 5 x 0.5) / 8 = 0.5 -> normalized (0.5 + 1) / 2
    expect(body.axes.individualVsCommunity).toBeCloseTo(0.75, 6);
  });

  // INT-11: a 1.0 or 1.1 Updates dismissal is not a vote, so it never stands for the pair.
  it("does not let a 1.0 or 1.1 dismissal on the primary hide the Yea on the other member", async () => {
    const body = await profileFor([
      { ...vote("BILLS-119hr1285", "Abstain", 1, "-0.9"), legacyDismiss: { BOOL: true } },
      vote("BILLS-119s570", "Yea", 2, "0.8"),
      vote("BILLS-119s1000", "Yea", 3, "0.2"),
      vote("BILLS-119hr77", "Yea", 4, "0.5"),
      ...otherVotes,
    ]);

    expect(body.totalVotesWithProfile).toBe(8);
    expect(body.votesUsed).toBe(8);
    // (0.8 + 0.2 + 0.5 + 5 x 0.5) / 8 = 0.5 -> normalized (0.5 + 1) / 2
    expect(body.axes.individualVsCommunity).toBeCloseTo(0.75, 6);
  });

  it("counts every vote while the published groups are turned off", async () => {
    const body = await profileFor(votes, false);

    expect(body.totalVotesWithProfile).toBe(9);
    // (0.8 - 0.8 + 0.2 + 0.5 + 5 x 0.5) / 9 = 0.3556 -> normalized
    expect(body.axes.individualVsCommunity).toBeCloseTo(0.6778, 4);
  });

  // UX-32: "Vote on N more bills" never rises under the cap as votes on bills not yet in the window are added. A vote on
  // the primary of a pair the user voted on through the other member is not added: its row replaces that vote (an
  // Abstain hides it), so N can go up by 1. RUNBOOK 20.1 documents it.
  it("lets a vote on the primary replace the counted vote on the other member, so N can go up by 1 (UX-32)", async () => {
    const scored = (billId: string, feedback: string, minute: number, axes: string[]) => ({
      bill_id: { S: billId },
      feedback: { S: feedback },
      votedAt: { S: new Date(Date.UTC(2026, 4, 1) + minute * 60_000).toISOString() },
      civicProfile: { M: Object.fromEntries(axes.map((axis) => [axis, { N: "0.5" }])) },
    });
    const bills = (prefix: string, count: number, from: number, axes: string[]) =>
      Array.from({ length: count }, (_, i) => scored(`BILLS-119hr${prefix}${i}`, "Yea", from + i, axes));
    // 25 votes: 8 on bills scored on the 1st and 2nd themes, 10 more on the 1st, and 7 on the 3rd, one of them the
    // Senate member of a pair (its primary is BILLS-119hr1285). The 3rd theme is 1 short: "Vote on 1 more bill".
    const window = [
      ...bills("31", 8, 0, ["individualVsCommunity", "localVsFederal"]),
      ...bills("32", 10, 10, ["individualVsCommunity"]),
      ...bills("33", 6, 20, ["freeMarketVsRegulated"]),
      scored("BILLS-119s570", "Yea", 30, ["freeMarketVsRegulated"]),
    ];
    const before = await profileFor(window);
    expect(before).toMatchObject({ votesUsed: 25, minVotesRequired: 26, isReady: false, lockedBy: "themes" });

    // A Yea on the primary, scored on the 1st theme only, replaces the Senate vote: still 25 votes, the 3rd theme at 6.
    const yea = await profileFor([...window, scored("BILLS-119hr1285", "Yea", 40, ["individualVsCommunity"])]);
    expect(yea).toMatchObject({ votesUsed: 25, minVotesRequired: 27, isReady: false, lockedBy: "themes" });

    // An Abstain on the primary hides it: 24 votes, the 3rd theme at 6, so 2 more again.
    const abstain = await profileFor([...window, scored("BILLS-119hr1285", "Abstain", 40, ["individualVsCommunity"])]);
    expect(abstain).toMatchObject({ votesUsed: 24, minVotesRequired: 26, isReady: false, lockedBy: "themes" });
  });
});
