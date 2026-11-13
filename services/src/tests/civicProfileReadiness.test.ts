jest.mock("@aws-sdk/client-dynamodb", () => {
  const actual = jest.requireActual("@aws-sdk/client-dynamodb");
  const mockSend = jest.fn();
  return {
    ...actual,
    DynamoDBClient: jest.fn(() => ({ send: mockSend })),
    __mockSend: mockSend,
  };
});

import type { AttributeValue, GetItemCommandInput, QueryCommandInput } from "@aws-sdk/client-dynamodb";
import { CIVIC_PROFILE_AXES } from "../models/bill";
import {
  CIVIC_PROFILE_MIN_READY_THEMES,
  CIVIC_PROFILE_MIN_THEME_VOTES,
  CIVIC_PROFILE_MIN_VOTES,
  CIVIC_PROFILE_WINDOW,
  civicProfileReadiness,
  civicProfileWindow,
} from "../shared/civicProfileReadiness";
import { MEMBER_CIVIC_PROFILE_MIN_READY_AXES } from "../shared/memberCivicProfile";
import { applyTestEnv } from "./fixtures/env";

type Item = Record<string, AttributeValue>;
/** The fields of the profile and score responses these tests read. */
interface Body {
  isReady?: boolean;
  honors?: Array<{ id: string }>;
}

const [A, B, C, D, E, F] = CIVIC_PROFILE_AXES;

describe("civicProfileReadiness (UX-32)", () => {
  // A window of `count` votes on bills scored on `themes`.
  const votes = (count: number, ...themes: string[]) => Array.from({ length: count }, () => ({ themes }));

  it("keeps the thresholds: 25 votes, 3 themes at 8 (the 3 a member's chart needs and a radar shape needs)", () => {
    expect([CIVIC_PROFILE_WINDOW, CIVIC_PROFILE_MIN_VOTES, CIVIC_PROFILE_MIN_THEME_VOTES]).toEqual([100, 25, 8]);
    expect(CIVIC_PROFILE_MIN_READY_THEMES).toBe(3);
    expect(CIVIC_PROFILE_MIN_READY_THEMES).toBe(MEMBER_CIVIC_PROFILE_MIN_READY_AXES);
  });

  // What the apps ask for: "Vote on N more bills".
  const asksFor = (readiness: { minVotesRequired: number; votesUsed: number }) =>
    readiness.minVotesRequired - readiness.votesUsed;

  it("asks a new user for 25 votes, and a user under 25 for the votes' shortfall while it is not the smaller", () => {
    expect(civicProfileReadiness([])).toMatchObject({
      isReady: false,
      votesUsed: 0,
      minVotesRequired: 25,
      themesReady: 0,
      lockedBy: "votes",
    });
    // 3 themes at 8 already: the votes alone hold it.
    expect(civicProfileReadiness(votes(24, A, B, C))).toMatchObject({
      isReady: false,
      votesUsed: 24,
      minVotesRequired: 25,
      themesReady: 3,
      lockedBy: "votes",
    });
    expect(civicProfileReadiness(votes(10, A, B, C))).toMatchObject({
      votesUsed: 10,
      minVotesRequired: 25,
      themesReady: 3,
      lockedBy: "votes",
    });
    // Under 18 votes the votes are at least 8 short, so never less than the 3rd theme (8 at most).
    expect(civicProfileReadiness(votes(12, A))).toMatchObject({ minVotesRequired: 25, lockedBy: "votes" });
    expect(civicProfileReadiness(votes(17, A))).toMatchObject({ minVotesRequired: 25, lockedBy: "votes" });
  });

  it("asks a user under 25 votes for the 3rd theme's shortfall when it is larger, so N does not jump at 25", () => {
    // All on one theme: from 18 votes the 3rd theme's 8 outweighs the votes', so N stays 8 across 25.
    for (let count = 18; count <= 25; count++) {
      expect(civicProfileReadiness(votes(count, A))).toMatchObject({
        isReady: false,
        votesUsed: count,
        minVotesRequired: count + 8,
        themesReady: 1,
        lockedBy: "themes",
      });
    }
    // 20 votes, the 3rd theme at 2: short by 6, the votes by 5.
    expect(civicProfileReadiness([...votes(9, A, B), ...votes(2, C), ...votes(9)])).toMatchObject({
      votesUsed: 20,
      minVotesRequired: 26,
      themesReady: 2,
      lockedBy: "themes",
    });
  });

  it("names the larger shortfall in lockedBy, the votes on a tie, and switches at 25 votes without changing N", () => {
    // 20 votes, the 3rd theme at 3: both 5 short.
    expect(civicProfileReadiness([...votes(10, A, B), ...votes(3, C), ...votes(7)])).toMatchObject({
      votesUsed: 20,
      minVotesRequired: 25,
      lockedBy: "votes",
    });

    // 24 votes, the 3rd theme at 7: both 1 short, so the votes; a 25th vote on another theme leaves the themes 1
    // short, so N stays 1 and the themes now set it; a 25th vote on the 3rd theme unlocks it.
    const shortOne = [...votes(8, A, B), ...votes(7, C), ...votes(9)];
    expect(civicProfileReadiness(shortOne)).toMatchObject({
      votesUsed: 24,
      minVotesRequired: 25,
      themesReady: 2,
      lockedBy: "votes",
    });
    expect(civicProfileReadiness([...shortOne, { themes: [D] }])).toMatchObject({
      votesUsed: 25,
      minVotesRequired: 26,
      lockedBy: "themes",
    });
    expect(civicProfileReadiness([...shortOne, { themes: [C] }])).toMatchObject({
      isReady: true,
      minVotesRequired: 25,
      lockedBy: null,
    });

    // 24 votes, the 3rd theme at 6: the themes 2 short, the votes 1, so the themes, before and after the 25th vote.
    const shortTwo = [...votes(8, A, B), ...votes(6, C), ...votes(10)];
    expect(civicProfileReadiness(shortTwo)).toMatchObject({ votesUsed: 24, minVotesRequired: 26, lockedBy: "themes" });
    expect(civicProfileReadiness([...shortTwo, { themes: [D] }])).toMatchObject({
      votesUsed: 25,
      minVotesRequired: 27,
      lockedBy: "themes",
    });
    expect(civicProfileReadiness([...shortTwo, { themes: [C] }])).toMatchObject({
      votesUsed: 25,
      minVotesRequired: 26,
      lockedBy: "themes",
    });
  });

  it("never raises N from 24 votes to 25, over every mix of themes", () => {
    // Readiness and N read the theme counts only through how many reach 8 and the 3rd-ranked count, where a count
    // above 8 acts as 8 would, before the vote and after it (a 3rd theme at 8 or more leaves only the votes short). So
    // every count from 0 to 8 on each theme (in falling order, as the themes are alike), with every set of themes for
    // the 25th vote, covers every case: 3,003 mixes and 64 sets.
    const mixes = (themes: number, most: number): number[][] =>
      themes === 0
        ? [[]]
        : Array.from({ length: most + 1 }, (_, top) => mixes(themes - 1, top).map((rest) => [top, ...rest])).flat();
    const failures: string[] = [];
    const seen = { mixes: 0, votes: 0, themes: 0, unlocked: 0 };
    for (const mix of mixes(CIVIC_PROFILE_AXES.length, CIVIC_PROFILE_MIN_THEME_VOTES)) {
      // 24 votes: the i-th is on the themes with more than i votes.
      const window = Array.from({ length: 24 }, (_, index) => ({
        themes: CIVIC_PROFILE_AXES.filter((_, axis) => mix[axis] > index),
      }));
      const before = civicProfileReadiness(window);
      if (before.isReady || before.votesUsed !== 24) failures.push(`${mix}: ${JSON.stringify(before)}`);
      seen.mixes += 1;
      seen[before.lockedBy === "themes" ? "themes" : "votes"] += 1;
      for (let set = 0; set < 1 << CIVIC_PROFILE_AXES.length; set++) {
        const themes = CIVIC_PROFILE_AXES.filter((_, axis) => set & (1 << axis));
        window.push({ themes });
        const after = civicProfileReadiness(window);
        window.pop();
        if (after.isReady) {
          seen.unlocked += 1;
          // Only from "1 more bill".
          if (asksFor(before) !== 1) failures.push(`${mix} + [${themes}]: unlocked from ${asksFor(before)}`);
        } else if (asksFor(after) > asksFor(before) || asksFor(after) < Math.max(1, asksFor(before) - 1)) {
          failures.push(`${mix} + [${themes}]: ${asksFor(before)} -> ${asksFor(after)}`);
        }
      }
    }
    expect(failures).toEqual([]);
    expect(seen.mixes).toBe(3003);
    // Both locks at 24 votes, and unlocks at 25.
    expect(Math.min(seen.votes, seen.themes, seen.unlocked)).toBeGreaterThan(100);
  }, 30_000);

  it.each([
    // [themes at 8, the window, minVotesRequired]
    [0, [...votes(5, A), ...votes(5, B), ...votes(5, C), ...votes(5, D), ...votes(5, E), ...votes(5, F)], 33],
    [0, votes(25, A, B, C).map((vote, index) => (index < 18 ? { themes: [] } : vote)), 26],
    [1, [...votes(10, A), ...votes(6, B), ...votes(5, C), ...votes(4, D)], 28],
    [1, votes(40, A), 48],
    [2, [...votes(8, A, B), ...votes(7, C), ...votes(10)], 26],
    [2, [...votes(9, A), ...votes(9, B), ...votes(2, C), ...votes(5)], 31],
  ])("from 25 votes, locks on the themes with %i at 8, asking for the 3rd theme's shortfall", (ready, window, min) => {
    const readiness = civicProfileReadiness(window);
    expect(readiness).toMatchObject({ isReady: false, themesReady: ready, lockedBy: "themes" });
    expect(readiness.votesUsed).toBeGreaterThanOrEqual(25);
    expect(readiness.minVotesRequired).toBe(min);
    expect(readiness.minVotesRequired - readiness.votesUsed).toBeGreaterThanOrEqual(1);
  });

  it("counts a theme from 8 votes exactly: 7 locks, 8 and 9 unlock", () => {
    const base = [...votes(8, A, B), ...votes(9)];
    const withThird = (count: number) => [...base, ...votes(count, C), ...votes(Math.max(0, 8 - count))];
    expect(civicProfileReadiness(withThird(7))).toMatchObject({
      isReady: false,
      votesUsed: 25,
      minVotesRequired: 26,
      themesReady: 2,
      lockedBy: "themes",
    });
    expect(civicProfileReadiness(withThird(8))).toMatchObject({
      isReady: true,
      votesUsed: 25,
      minVotesRequired: 25,
      themesReady: 3,
      lockedBy: null,
    });
    expect(civicProfileReadiness(withThird(9))).toMatchObject({ isReady: true, votesUsed: 26, themesReady: 3 });
  });

  it("counts a vote whose bill's profile is not known toward nothing, and a theme once per vote", () => {
    const readiness = civicProfileReadiness([
      ...votes(30, A, B, C).map((vote, index) => (index < 10 ? { themes: null } : vote)),
      { themes: [D, D, "notATheme", "toString"] },
    ]);
    expect(readiness.votesUsed).toBe(21);
    expect(readiness.themeVotes).toEqual({ [A]: 20, [B]: 20, [C]: 20, [D]: 1, [E]: 0, [F]: 0 });
    expect(readiness.isReady).toBe(false);
    expect(readiness.lockedBy).toBe("votes");
  });

  it("never asks for more votes as votes are added under the cap, and unlocks only from 1 more, over 400 histories", () => {
    const failures: string[] = [];
    const seen = { unlocked: 0, themesUnder25: 0, full: 0 };
    for (let seed = 1; seed <= 400; seed++) {
      const random = seeded(seed);
      // Each theme its own odds, so some histories leave a 3rd theme behind; now and then a vote whose bill's profile
      // is not known (it takes a place and counts for nothing).
      const odds = CIVIC_PROFILE_AXES.map(() => random() ** 2 * 0.5);
      const window: { themes: string[] | null }[] = [];
      let last = civicProfileReadiness(window);
      let unlocked = false;
      expect(asksFor(last)).toBe(CIVIC_PROFILE_MIN_VOTES);
      while (!unlocked && window.length < CIVIC_PROFILE_WINDOW) {
        window.push({ themes: random() < 0.05 ? null : CIVIC_PROFILE_AXES.filter((_, axis) => random() < odds[axis]) });
        const next = civicProfileReadiness(window);
        if (next.isReady) {
          unlocked = true;
          seen.unlocked += 1;
          if (asksFor(last) !== 1)
            failures.push(`seed ${seed}, ${window.length} votes: unlocked from ${asksFor(last)}`);
          continue;
        }
        if (asksFor(next) > asksFor(last) || asksFor(next) < Math.max(1, asksFor(last) - 1)) {
          failures.push(`seed ${seed}, ${window.length} votes: ${asksFor(last)} -> ${asksFor(next)}`);
        }
        if (next.lockedBy === "themes" && next.votesUsed < CIVIC_PROFILE_MIN_VOTES) seen.themesUnder25 += 1;
        last = next;
      }
      if (!unlocked) seen.full += 1;
    }
    expect(failures).toEqual([]);
    // The histories reach an unlock, a theme lock under 25 votes, and a full window still locked.
    expect(seen.unlocked).toBeGreaterThan(100);
    expect(seen.themesUnder25).toBeGreaterThan(100);
    expect(seen.full).toBeGreaterThan(10);
  });

  it("asks for 1 to 8 more votes while the themes hold it; at the 100-vote cap N can go back up, never above 8", () => {
    const timed = (minute: number, ...themes: string[]) => ({
      votedAt: new Date(Date.UTC(2026, 0, 1) + minute * 60_000).toISOString(),
      themes,
    });
    const asked = (history: { votedAt: string; themes: string[] }[]) => {
      const readiness = civicProfileReadiness(civicProfileWindow(history));
      const n = readiness.minVotesRequired - readiness.votesUsed;
      return { isReady: readiness.isReady, n, minVotesRequired: readiness.minVotesRequired };
    };

    // The most it asks for: no vote at all on a 3rd theme, under the cap and at it.
    expect(civicProfileReadiness(votes(25, A))).toMatchObject({ minVotesRequired: 33, lockedBy: "themes" });
    expect(civicProfileReadiness(votes(100, A, B))).toMatchObject({ minVotesRequired: 108, lockedBy: "themes" });

    // 100 votes: the oldest 7 on C, then 93 on A and B. One more vote on C would unlock it.
    const history = [
      ...Array.from({ length: 7 }, (_, index) => timed(index, C)),
      ...Array.from({ length: 93 }, (_, index) => timed(7 + index, A, B)),
    ];
    expect(asked(history)).toEqual({ isReady: false, n: 1, minVotesRequired: 101 });
    // Votes on D push the votes on C out one by one: N goes back up, then down as D nears 8.
    const seen: number[] = [];
    for (let minute = 100; minute < 107; minute++) {
      history.push(timed(minute, D));
      seen.push(asked(history).n);
    }
    expect(seen).toEqual([2, 3, 4, 4, 3, 2, 1]);
    history.push(timed(107, D));
    expect(asked(history)).toMatchObject({ isReady: true, minVotesRequired: 25 });

    // Random windows at the cap: never 0, never above 8.
    let locked = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const random = seeded(seed);
      const window = Array.from({ length: CIVIC_PROFILE_WINDOW }, () => ({
        themes: CIVIC_PROFILE_AXES.filter(() => random() < 0.07),
      }));
      const readiness = civicProfileReadiness(window);
      if (readiness.lockedBy !== "themes") continue;
      const remaining = readiness.minVotesRequired - readiness.votesUsed;
      expect(remaining).toBeGreaterThanOrEqual(1);
      expect(remaining).toBeLessThanOrEqual(CIVIC_PROFILE_MIN_THEME_VOTES);
      locked += 1;
    }
    expect(locked).toBeGreaterThan(50);
  });

  it("orders the window newest first by votedAt and keeps the 100 most recent, stably", () => {
    const rows = Array.from({ length: 120 }, (_, index) => ({
      id: index,
      votedAt: new Date(Date.UTC(2026, 0, 1) + Math.floor(index / 2) * 60_000).toISOString(),
    }));
    const window = civicProfileWindow(rows);
    expect(window).toHaveLength(100);
    expect(window[0].id).toBe(118);
    expect(window[1].id).toBe(119);
    expect(window[99].id).toBe(21);
    expect(rows[0].id).toBe(0);
  });
});

// ── The chart and the honor on the same votes ───────────────────────────────────────────────────

const USER = "user-1";
const FEEDBACK_TABLE = "UserBillFeedback";
const MANIFEST_TABLE = "BillsManifest";
const PII_TABLE = "UserPII";
const PAIRS: [string, string][] = [1, 2, 3, 4, 5].map((n) => [`BILLS-119hr${n}`, `BILLS-119s${n}`]);

let rows: Item[];
let manifestProfiles: Map<string, AttributeValue>;
let storedHonors: string[];

const route = async (command: {
  constructor: { name: string };
  input: Partial<QueryCommandInput & GetItemCommandInput>;
}) => {
  const op: string = command.constructor.name;
  const input = command.input;
  if (op === "QueryCommand" && input.TableName === FEEDBACK_TABLE) return { Items: rows.map((row) => ({ ...row })) };
  if (op === "GetItemCommand" && input.TableName === MANIFEST_TABLE) {
    const pk = input.Key!.pk.S!;
    const sk = input.Key!.sk.S!;
    if (pk === "BILL_COMPANION_GROUPS") {
      return {
        Item: {
          pk: { S: pk },
          sk: { S: sk },
          pairsVersion: { N: "1" },
          enabled: { BOOL: true },
          pairs: { S: JSON.stringify(PAIRS) },
        },
      };
    }
    if (pk === "BILL_GUID") return manifestProfiles.has(sk) ? { Item: { manifestSk: { S: `m#${sk}` } } } : {};
    if (pk === "BILL") return { Item: { civicProfile: manifestProfiles.get(sk.slice(2)) } };
  }
  // A record that exists and holds no Civic Compass yet, so every read earns honors by the rule, not by a seed.
  if (op === "GetItemCommand" && input.TableName === PII_TABLE) {
    return {
      Item: {
        user_id: { S: USER },
        civicEasternFrom: { S: "2026-01-01T05:00:00.000Z" },
        civicVotes: { N: "0" },
        civicVoteRows: { N: "0" },
        civicCountedVotes: { N: "0" },
        civicBestStreak: { N: "0" },
        ...(storedHonors.length ? { civicHonors: { SS: storedHonors } } : {}),
      },
    };
  }
  if (op === "UpdateItemCommand" && input.TableName === PII_TABLE) return {};
  throw new Error(`Unexpected ${op} on ${input.TableName}`);
};

let profileHandler: (event: unknown) => Promise<{ statusCode: number; body: string }>;
let scoreHandler: (event: unknown) => Promise<{ statusCode: number; body: string }>;
let restoreEnv: () => void;

beforeEach(() => {
  rows = [];
  manifestProfiles = new Map();
  storedHonors = [];
  restoreEnv = applyTestEnv({
    TABLE_NAME: FEEDBACK_TABLE,
    PARTITION_KEY: "user_id",
    SORT_KEY: "billId",
    MANIFEST_TABLE_NAME: MANIFEST_TABLE,
    MANIFEST_PRIMARY_KEY: "pk",
    MANIFEST_SORT_KEY: "sk",
    MANIFEST_GUID_LOOKUP_PK: "BILL_GUID",
    PII_TABLE_NAME: PII_TABLE,
    PII_PARTITION_KEY: "user_id",
  });
  jest.resetModules();
  const { __mockSend: send } = jest.requireMock("@aws-sdk/client-dynamodb");
  send.mockReset();
  send.mockImplementation(route);
  profileHandler = require("../handlers/fetchCivicProfile").handler;
  scoreHandler = require("../handlers/fetchCivicScore").handler;
  jest.spyOn(console, "log").mockImplementation(() => undefined);
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  restoreEnv();
  jest.restoreAllMocks();
});

const event = { requestContext: { authorizer: { jwt: { claims: { sub: USER } } } } };
const read = async (handler: typeof profileHandler): Promise<Body> => {
  const response = await handler(event);
  expect(response.statusCode).toBe(200);
  return JSON.parse(response.body);
};
const chartAndHonor = async () => {
  const profile = await read(profileHandler);
  const score = await read(scoreHandler);
  return { profile, compass: score.honors!.some((honor: { id: string }) => honor.id === "civic-compass") };
};

function seeded(seed: number) {
  return () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
}
const profileMap = (themes: string[], score = "0.5"): AttributeValue => ({
  M: Object.fromEntries(themes.map((theme) => [theme, { N: score }])),
});
const at = (minute: number) => new Date(Date.UTC(2026, 4, 1) + minute * 60_000).toISOString();
const vote = (billId: string, feedback: string, minute: number | null, themes?: string[]): Item => ({
  user_id: { S: USER },
  billId: { S: billId },
  feedback: { S: feedback },
  ...(minute === null ? {} : { votedAt: { S: at(minute) } }),
  ...(themes ? { civicProfile: profileMap(themes) } : {}),
});
/** `count` Yea votes on new bills scored on `themes`, from minute `from`. */
const themed = (count: number, themes: string[], from: number, prefix = "hr") =>
  Array.from({ length: count }, (_, index) =>
    vote(`BILLS-119${prefix}${1000 + from + index}`, "Yea", from + index, themes),
  );

describe("Civic Compass follows GET /civic-profile's readiness (UX-32)", () => {
  it.each([
    ["24 votes, 3 themes at 8", () => themed(24, [A, B, C], 0), false],
    [
      "25 votes, no theme at 8",
      () => [...themed(7, [A], 0), ...themed(7, [B], 7), ...themed(7, [C], 14), ...themed(4, [D], 21)],
      false,
    ],
    ["25 votes, 1 theme at 8", () => themed(25, [A], 0), false],
    [
      "25 votes, 2 themes at 8 and the 3rd at 7",
      () => [...themed(8, [A, B], 0), ...themed(7, [C], 8), ...themed(5, [D], 15), ...themed(5, [E], 20)],
      false,
    ],
    [
      "25 votes, 3 themes at 8",
      () => [...themed(8, [A, B], 0), ...themed(8, [C], 8), ...themed(5, [D], 16), ...themed(4, [E], 21)],
      true,
    ],
    [
      "26 votes, the 3rd theme at 9",
      () => [...themed(8, [A, B], 0), ...themed(9, [C], 8), ...themed(5, [D], 17), ...themed(4, [E], 22)],
      true,
    ],
  ])("%s: the honor comes exactly when the chart unlocks", async (_label, build, expected) => {
    rows = build();
    const { profile, compass } = await chartAndHonor();
    expect(profile.isReady).toBe(expected);
    expect(compass).toBe(expected);
  });

  it("at the 100-vote cap, counts only the themes of the last 100 Yea or Nay votes, as the chart", async () => {
    // 120 votes: the oldest 20 on a third theme, which the window no longer holds. Abstains in between take no place.
    rows = [
      ...themed(20, [C], 0),
      ...themed(100, [A, B], 20),
      ...Array.from({ length: 10 }, (_, index) => vote(`BILLS-119hr${3000 + index}`, "Abstain", 200 + index, [C])),
    ];
    let result = await chartAndHonor();
    expect(result.profile).toMatchObject({ votesUsed: 100, totalVotesWithProfile: 120, isReady: false });
    expect(result.compass).toBe(false);

    // Eight new votes on the third theme push the oldest eight out: 3 themes at 8 in the last 100.
    rows = [...rows, ...themed(8, [C], 300)];
    result = await chartAndHonor();
    expect(result.profile).toMatchObject({ votesUsed: 100, isReady: true, themesReady: 3 });
    expect(result.compass).toBe(true);
  });

  it("comes later than the chart, never earlier, for votes whose rows carry no profile of their own", async () => {
    // The chart reads these 25 bills' profiles from the manifest; the score reads no manifest.
    rows = Array.from({ length: 25 }, (_, index) => vote(`BILLS-119hr${4000 + index}`, "Yea", index));
    rows.forEach((row) => manifestProfiles.set(row.billId.S!, profileMap([A, B, C])));
    let result = await chartAndHonor();
    expect(result.profile.isReady).toBe(true);
    expect(result.compass).toBe(false);

    // A vote with no votedAt is not in the chart's window, so it does not count for the honor either.
    rows = [
      ...themed(24, [A, B, C], 0),
      vote("BILLS-119hr5000", "Yea", null, [A, B, C]),
      vote("BILLS-119hr5001", "Abstain", 30, [A, B, C]),
    ];
    result = await chartAndHonor();
    expect(result.profile).toMatchObject({ votesUsed: 24, isReady: false });
    expect(result.compass).toBe(false);
  });

  it("is not earned when newer votes whose profile only the manifest has push the others out of the chart", async () => {
    // 30 older votes whose rows carry a profile on three themes, then 100 newer ones on bills scored after the vote
    // (no profile on the row; the manifest has one, on a fourth theme). The chart's window is the 100 newer votes, one
    // theme: locked. A window over the rows with their own profile alone would hold the 30 older votes and unlock.
    rows = [
      ...themed(30, [A, B, C], 0),
      ...Array.from({ length: 100 }, (_, index) => vote(`BILLS-119hr${6000 + index}`, "Yea", 100 + index)),
    ];
    rows.slice(30).forEach((row) => manifestProfiles.set(row.billId.S!, profileMap([D])));
    const { profile, compass } = await chartAndHonor();
    expect(profile).toMatchObject({ votesUsed: 100, totalVotesWithProfile: 130, isReady: false, lockedBy: "themes" });
    expect(compass).toBe(false);
  });

  it("comes later than the chart while newer votes on bills scored on no theme fill the honor's last 100", async () => {
    // 100 votes on three themes (C, the oldest, at 12), then 40 newer Yea votes on bills scored on no theme: no profile
    // on the row or in the manifest. The chart skips those and keeps its 100. The honor cannot tell them from votes
    // whose profile only the manifest has, so they take 40 places of its window, which then holds no vote on C.
    rows = [
      ...themed(12, [C], 0),
      ...themed(88, [A, B], 12),
      ...Array.from({ length: 40 }, (_, index) => vote(`BILLS-119hr${7000 + index}`, "Yea", 200 + index)),
    ];
    let result = await chartAndHonor();
    expect(result.profile).toMatchObject({ votesUsed: 100, themesReady: 3, isReady: true });
    expect(result.compass).toBe(false);

    // 8 newer votes on C: its window holds 8 on C, 40 unscored and 52 on A and B, so it comes.
    rows = [...rows, ...themed(8, [C], 300)];
    result = await chartAndHonor();
    expect(result.profile).toMatchObject({ votesUsed: 100, isReady: true });
    expect(result.compass).toBe(true);
  });

  it("keeps a stored Civic Compass (UX-31) while the chart is locked again", async () => {
    storedHonors = ["civic-compass"];
    rows = themed(30, [A], 0);
    const { profile, compass } = await chartAndHonor();
    expect(profile).toMatchObject({ isReady: false, lockedBy: "themes" });
    expect(compass).toBe(true);
  });

  it("counts a companion pair once on both sides: a vote on the other member takes no place", async () => {
    // 25 votes with 3 themes at 8, two of them on one pair (hr1 and s1): 24 count, so neither unlocks.
    rows = [
      vote("BILLS-119hr1", "Yea", 0, [A, B, C]),
      vote("BILLS-119s1", "Nay", 1, [A, B, C]),
      ...themed(7, [A, B, C], 2),
      ...themed(16, [D], 9),
    ];
    let result = await chartAndHonor();
    expect(result.profile).toMatchObject({ votesUsed: 24, isReady: false });
    expect(result.compass).toBe(false);

    rows = [...rows, ...themed(1, [A, B, C], 40)];
    result = await chartAndHonor();
    expect(result.profile).toMatchObject({ votesUsed: 25, isReady: true });
    expect(result.compass).toBe(true);
  });

  // Random histories of Yea, Nay, Abstain and dismissals, on bills in and out of companion pairs, with rows that carry
  // a profile, an empty one or none (the manifest then has one or not), and rows with no votedAt.
  const history = (seed: number, { ownProfiles }: { ownProfiles: "some" | "all" }) => {
    const random = seeded(seed);
    const pick = () => CIVIC_PROFILE_AXES.filter((_, index) => random() < [0.5, 0.4, 0.3, 0.2, 0.15, 0.1][index]);
    const history: Item[] = [];
    const used = new Set<string>();
    let minute = 0;
    const count = Math.floor(random() * 170);
    for (let index = 0; index < count; index++) {
      const billId =
        random() < 0.08
          ? `BILLS-119${random() < 0.5 ? "hr" : "s"}${1 + Math.floor(random() * 5)}`
          : `BILLS-119hr${100 + index}`;
      if (used.has(billId)) continue;
      used.add(billId);
      const feedback = random() < 0.2 ? "Abstain" : random() < 0.55 ? "Yea" : "Nay";
      if (random() > 0.1) minute += Math.floor(random() * 600);
      const timed = ownProfiles === "all" || random() > 0.04;
      const row = vote(billId, feedback, timed ? minute : null);
      if (feedback === "Abstain" && random() < 0.2) row.legacyDismiss = { BOOL: true };
      // Newer votes are likelier to be on bills scored after the vote (no profile on the row).
      if (ownProfiles === "all" || random() < 0.95 - (0.7 * index) / Math.max(1, count)) {
        const themes = pick();
        row.civicProfile = themes.length
          ? profileMap(themes, String(random() * 2 - 1))
          : { M: { other: { N: "0.1" } } };
      } else if (random() < 0.1) {
        row.civicProfile = { M: {} };
      }
      if (!row.civicProfile?.M || !Object.keys(row.civicProfile.M).length) {
        const themes = pick();
        if (random() < 0.6) manifestProfiles.set(billId, profileMap(themes.length ? themes : [A]));
      }
      history.push(row);
    }
    return history;
  };

  it("is never earned while the chart is locked, over 300 random histories", async () => {
    let unlocked = 0;
    let earned = 0;
    let later = 0;
    for (let seed = 1; seed <= 300; seed++) {
      manifestProfiles = new Map();
      rows = history(seed, { ownProfiles: "some" });
      const { profile, compass } = await chartAndHonor();
      if (compass) expect(profile.isReady).toBe(true);
      unlocked += profile.isReady ? 1 : 0;
      earned += compass ? 1 : 0;
      later += profile.isReady && !compass ? 1 : 0;
    }
    // The histories reach both sides of the rule, and the honor's later case.
    expect(earned).toBeGreaterThan(20);
    expect(unlocked).toBeGreaterThan(earned);
    expect(later).toBeGreaterThan(0);
    expect(unlocked).toBeLessThan(300);
  });

  it("comes exactly with the chart when every timed row carries its own profile, past 100 votes too", async () => {
    let unlocked = 0;
    for (let seed = 1; seed <= 150; seed++) {
      manifestProfiles = new Map();
      rows = history(seed, { ownProfiles: "all" });
      const { profile, compass } = await chartAndHonor();
      expect(compass).toBe(profile.isReady);
      unlocked += profile.isReady ? 1 : 0;
    }
    expect(unlocked).toBeGreaterThan(20);
    expect(unlocked).toBeLessThan(150);
  });
});
