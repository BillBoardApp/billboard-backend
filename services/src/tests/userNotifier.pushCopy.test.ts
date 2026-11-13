import type { SQSEvent } from "aws-lambda";
import {
  formatActionDate,
  leadRow,
  pushActionPhrase,
  pushCopyFor,
  pushPayloadDetails,
  type PushRow,
} from "../handlers/userNotifier/pushCopy";
import { applyTestEnv } from "./fixtures/env";

/*
 * S4 and S5 (feature review 2026-10-28): what a push says and which type it carries. The copy is tested on its own,
 * then through the handler, with the payload checked against what app 1.1 (App Store) and 1.2 read: `aps.alert`,
 * `domain`, `billId`, `billIds`, `billCount`, `notificationType`, `category`, `subCategory` and the nested `alert`
 * (`text`, `actionDate`, `actionCode`), in PushNotificationPayload.swift, which is the same in both.
 */

const NOW = Date.parse("2026-10-28T16:00:00Z");
const byBill = (billId: string) => billId;

const row = (overrides: Partial<PushRow> & Pick<PushRow, "notificationType">): PushRow => ({
  billId: "BILLS-119hr77",
  billTitle: "Rural Broadband Access Act",
  category: "Bill Alert",
  ...overrides,
});

describe("the action in plain words (S4)", () => {
  it.each([
    ["8000", "Passed/agreed to in House: On motion to suspend the rules and pass the bill.", "Passed the House"],
    ["17000", "Passed Senate without amendment by Unanimous Consent.", "Passed the Senate"],
    ["9000", "Failed of passage by recorded vote: 190 - 228.", "Failed in the House"],
    ["18000", "Failed of passage in Senate.", "Failed in the Senate"],
    ["33000", "Failed to override veto.", "House failed to override the veto"],
    ["35000", "Failed to override veto.", "Senate failed to override the veto"],
  ])("says code %s in words", (actionCode, text, phrase) => {
    expect(pushActionPhrase({ text, actionCode })).toBe(phrase);
  });

  // REL-44: every law line says what both apps label Finalized, so the lines of one law read as one action.
  it.each([
    ["36000", "Signed by President.", "BecameLaw"],
    ["36000", "Became Public Law No: 119-52.", "BecameLaw"],
    ["E40000", "Became Public Law No: 119-52.", "President"],
    ["36000", "Became Private Law No: 119-1.", "BecameLaw"],
  ])("says a law line (code %s, %j) as 'Became law'", (actionCode, text, actionType) => {
    expect(pushActionPhrase({ text, actionCode, actionType })).toBe("Became law");
  });

  it("puts 'Became law' in a law push's body and the apps' Recent actions row", () => {
    const law = row({
      notificationType: "alert",
      action: { text: "Became Public Law No: 119-52.", actionDate: "2026-10-27", actionCode: "E40000" },
    });
    expect(pushCopyFor([law], byBill, NOW)).toEqual({
      title: "Action: Rural Broadband Access Act",
      body: "Became law · Oct 27",
      notificationType: "alert",
    });
    expect(pushPayloadDetails([law], "alert", byBill).alert).toEqual({
      text: "Became law",
      actionDate: "2026-10-27",
      actionCode: "E40000",
    });
  });

  // REL-50: the bill can come back under a rule, so its action push does not say it failed (wording approved by the
  // project 2026-10-29).
  it.each([
    [
      "9000",
      "Failed of passage/not agreed to in House: On motion to suspend the rules and pass the bill Failed by the Yeas and Nays: (2/3 required): 250 - 180 (Roll no. 38).",
    ],
    [
      "H37300",
      "On motion to suspend the rules and pass the bill, as amended Failed by the Yeas and Nays: (2/3 required).",
    ],
  ])("says a failed suspension vote (code %s) fell short of two thirds", (actionCode, text) => {
    expect(pushActionPhrase({ text, actionCode })).toBe("House vote fell short of two-thirds");
  });

  // REL-50: a failed Senate vote under a 60-vote order; the Senate can take the bill up again (H.R. 5371 became law).
  it.each([
    [
      "18000",
      "Failed of passage/not agreed to in Senate: Under the order of 9/18/2025, not having achieved 60 votes in the affirmative, failed of passage in Senate by Yea-Nay Vote. 44 - 48. Record Vote Number: 528.",
    ],
    [
      undefined,
      "Upon reconsideration, under the order of 9/18/2025, not having achieved 60 votes in the affirmative, failed of passage in Senate by Yea-Nay Vote. 55 - 45. Record Vote Number: 535.",
    ],
  ])("says a failed 60-vote Senate vote (code %s) fell short of 60 votes", (actionCode, text) => {
    expect(pushActionPhrase({ text, actionCode })).toBe("Senate vote fell short of 60");
  });

  it("uses Congress's text for a failure code on a line that is not the bill's own failure (REL-50)", () => {
    expect(
      pushActionPhrase({
        text: "Failed of passage/not agreed to in Senate: Cloture motion not invoked.",
        actionCode: "18000",
      }),
    ).toBe("Failed of passage/not agreed to in Senate: Cloture motion not invoked");
  });

  it.each([
    ["Reported by the Committee on Energy and Commerce.", "Reported by the Committee on Energy and Commerce"],
    [
      "Motion to reconsider laid on the table Agreed to without objection. (text: CR H4567-4570)",
      "Motion to reconsider laid on the table Agreed to without objection",
    ],
    [
      "On motion to recommit Failed by the Yeas and Nays: 201 - 215 (Roll no. 301).",
      "On motion to recommit Failed by the Yeas and Nays: 201 - 215",
    ],
    [
      "Considered under the provisions of rule H. Res. 12. (consideration: CR H101-110; text: CR H111)",
      "Considered under the provisions of rule H. Res. 12",
    ],
    ["  Referred to the\n House Committee on Ways and Means.  ", "Referred to the House Committee on Ways and Means"],
    ["Became Public Law No: 119-41.", "Became Public Law No: 119-41"],
    ["Title updated: Rural Broadband Access Act of 2026", "Title updated: Rural Broadband Access Act of 2026"],
    ["Referred to the Subcommittee on Health…", "Referred to the Subcommittee on Health…"],
  ])("uses Congress's text for other actions: %j", (text, phrase) => {
    expect(pushActionPhrase({ text, actionCode: "H11100" })).toBe(phrase);
  });

  it("has no phrase without an action, or for notificationType's 'Bill updated' fallback", () => {
    expect(pushActionPhrase(undefined)).toBeNull();
    expect(pushActionPhrase({ text: "Bill updated" })).toBeNull();
  });

  it("dates an action as a calendar day, with the year only when it is not this year", () => {
    expect(formatActionDate("2026-10-27", NOW)).toBe("Oct 27");
    expect(formatActionDate("2026-01-05T14:00:00Z", NOW)).toBe("Jan 5");
    expect(formatActionDate("2025-12-30", NOW)).toBe("Dec 30, 2025");
    expect(formatActionDate("yesterday", NOW)).toBeNull();
    expect(formatActionDate("2026-13-01", NOW)).toBeNull();
    expect(formatActionDate(undefined, NOW)).toBeNull();
  });
});

describe("single-bill wording for each type (S4)", () => {
  const action = {
    text: "Reported by the Committee on Energy and Commerce.",
    actionDate: "2026-10-27",
    actionCode: "5000",
  };

  it.each<[string, PushRow, { title: string; body: string }]>([
    [
      "new",
      row({ notificationType: "new" }),
      { title: "New: Rural Broadband Access Act", body: "A new bill matched your interests." },
    ],
    [
      "updated",
      row({ notificationType: "updated" }),
      { title: "Updated: Rural Broadband Access Act", body: "Open Billboard to see what changed." },
    ],
    [
      "alert",
      row({ notificationType: "alert", action }),
      {
        title: "Action: Rural Broadband Access Act",
        body: "Reported by the Committee on Energy and Commerce · Oct 27",
      },
    ],
    [
      "passed",
      row({
        notificationType: "passed",
        action: { text: "Passed/agreed to in House.", actionDate: "2026-10-27", actionCode: "8000" },
      }),
      { title: "Passed: Rural Broadband Access Act", body: "Passed the House · Oct 27" },
    ],
    [
      "failed",
      row({
        notificationType: "failed",
        action: { text: "Failed of passage in Senate.", actionDate: "2026-10-27", actionCode: "18000" },
      }),
      { title: "Failed: Rural Broadband Access Act", body: "Failed in the Senate · Oct 27" },
    ],
    [
      "failed, found by its text (the Senate's line, before the Library of Congress codes it; REL-50)",
      row({
        notificationType: "failed",
        action: { text: "Failed of passage in Senate by Yea-Nay Vote. 45 - 55.", actionDate: "2026-10-27" },
      }),
      {
        title: "Failed: Rural Broadband Access Act",
        body: "Failed of passage in Senate by Yea-Nay Vote. 45 - 55 · Oct 27",
      },
    ],
    [
      "alert for a failed suspension vote: the approved words and the action's date (REL-50)",
      row({
        notificationType: "alert",
        action: {
          text: "Failed of passage/not agreed to in House: On motion to suspend the rules and pass the bill Failed by the Yeas and Nays: (2/3 required): 250 - 180 (Roll no. 38).",
          actionDate: "2026-10-27",
          actionCode: "9000",
        },
      }),
      { title: "Action: Rural Broadband Access Act", body: "House vote fell short of two-thirds · Oct 27" },
    ],
    [
      "alert for a failed 60-vote Senate vote in another year: the approved words, the date with its year (REL-50)",
      row({
        notificationType: "alert",
        action: {
          text: "Failed of passage/not agreed to in Senate: Under the order of 9/18/2025, not having achieved 60 votes in the affirmative, failed of passage in Senate by Yea-Nay Vote. 44 - 48. Record Vote Number: 528.",
          actionDate: "2025-09-19",
          actionCode: "18000",
        },
      }),
      { title: "Action: Rural Broadband Access Act", body: "Senate vote fell short of 60 · Sep 19, 2025" },
    ],
    [
      "an action without a date",
      row({ notificationType: "alert", action: { text: "Title updated: Rural Broadband Act" } }),
      { title: "Action: Rural Broadband Access Act", body: "Title updated: Rural Broadband Act" },
    ],
  ])("%s", (_type, pushRow, expected) => {
    const copy = pushCopyFor([pushRow], byBill, NOW);
    expect({ title: copy.title, body: copy.body }).toEqual(expected);
    expect(copy.notificationType).toBe(pushRow.notificationType);
    expect(JSON.stringify(copy)).not.toContain("BillBoard");
  });

  it.each<[PushRow["notificationType"], string]>([
    ["alert", "Congress updated this bill's record."],
    ["passed", "It passed a vote in Congress."],
    ["failed", "It failed a vote in Congress."],
  ])("a %s row with no action (written before S4) gets a plain fallback", (notificationType, body) => {
    expect(pushCopyFor([row({ notificationType })], byBill, NOW).body).toBe(body);
    expect(pushCopyFor([row({ notificationType, action: { text: "Bill updated" } })], byBill, NOW).body).toBe(body);
  });

  it("shortens a long action and keeps its date", () => {
    const text = `Referred to the Committee on Energy and Commerce, and in addition to the Committees on Ways and Means, and Education and the Workforce, for a period to be subsequently determined by the Speaker.`;
    const copy = pushCopyFor(
      [row({ notificationType: "alert", action: { text, actionDate: "2026-10-27" } })],
      byBill,
      NOW,
    );
    expect(copy.body).toMatch(/^Referred to the Committee on Energy and Commerce, .*\.\.\. · Oct 27$/);
    expect(Buffer.byteLength(copy.body, "utf8")).toBeLessThanOrEqual(160);
  });
});

describe("folding several rows into one push (S5)", () => {
  const bill = (n: number, type: PushRow["notificationType"], extra: Partial<PushRow> = {}) =>
    row({ billId: `BILLS-119hr${n}`, billTitle: `Bill ${n}`, notificationType: type, ...extra });

  it.each<[string, PushRow[], { title: string; body: string; notificationType: string }]>([
    [
      "new bills keep 'new'",
      [bill(1, "new"), bill(2, "new"), bill(3, "new")],
      { title: "3 New Bills for You", body: "Includes Bill 1, Bill 2, and 1 more.", notificationType: "new" },
    ],
    [
      "updated bills keep 'updated', so both apps ask to vote again on each",
      [bill(1, "updated"), bill(2, "updated")],
      { title: "2 Bills Changed", body: "Includes Bill 1 and Bill 2.", notificationType: "updated" },
    ],
    [
      // Both apps read an alert push as one bill (its first id), so several bills' actions stay a digest.
      "actions on several bills stay a 'digest'",
      [bill(1, "alert"), bill(2, "alert")],
      { title: "Action on 2 Bills", body: "Includes Bill 1 and Bill 2.", notificationType: "digest" },
    ],
    [
      "one bill's action keeps 'alert'",
      [bill(1, "alert", { action: { text: "Referred to the Committee on Finance.", actionDate: "2026-10-27" } })],
      { title: "Action: Bill 1", body: "Referred to the Committee on Finance · Oct 27", notificationType: "alert" },
    ],
    [
      "passed bills keep 'passed'",
      [bill(1, "passed"), bill(2, "passed")],
      { title: "2 Bills Passed", body: "Includes Bill 1 and Bill 2.", notificationType: "passed" },
    ],
    [
      "failed bills keep 'failed'",
      [bill(1, "failed"), bill(2, "failed")],
      { title: "2 Bills Failed", body: "Includes Bill 1 and Bill 2.", notificationType: "failed" },
    ],
    [
      "mixed types are a digest",
      [bill(1, "new"), bill(2, "alert"), bill(3, "alert"), bill(4, "passed")],
      { title: "4 Bill Updates", body: "1 new, 2 actions, 1 passed", notificationType: "digest" },
    ],
    [
      "one bill's action and outcome are said by the outcome",
      [
        bill(1, "alert", {
          action: { text: "Passed/agreed to in House.", actionDate: "2026-10-27", actionCode: "8000" },
        }),
        bill(1, "passed", {
          action: { text: "Passed/agreed to in House.", actionDate: "2026-10-27", actionCode: "8000" },
        }),
      ],
      { title: "Passed: Bill 1", body: "Passed the House · Oct 27", notificationType: "digest" },
    ],
    [
      "one bill's new and action rows are said by the action",
      [
        bill(1, "new"),
        bill(1, "alert", { action: { text: "Referred to the Committee on Finance.", actionDate: "2026-10-27" } }),
      ],
      { title: "Action: Bill 1", body: "Referred to the Committee on Finance · Oct 27", notificationType: "digest" },
    ],
  ])("%s", (_case, rows, expected) => {
    expect(pushCopyFor(rows, byBill, NOW)).toEqual(expected);
  });

  it("counts a companion pair as one bill", () => {
    const pair = (billId: string) => (billId === "BILLS-119s570" ? "BILLS-119hr1285" : billId);
    const rows = [
      row({ billId: "BILLS-119hr1285", billTitle: "House Water Act", notificationType: "new" }),
      row({ billId: "BILLS-119s570", billTitle: "Senate Water Act", notificationType: "passed" }),
    ];
    expect(pushCopyFor(rows, pair, NOW)).toEqual({
      title: "Passed: Senate Water Act",
      body: "It passed a vote in Congress.",
      notificationType: "digest",
    });
  });

  it("leads with failed, then passed, then an action, then new, then updated", () => {
    const types: PushRow["notificationType"][] = ["updated", "new", "alert", "passed", "failed"];
    expect(leadRow(types.map((notificationType) => row({ notificationType }))).notificationType).toBe("failed");
    expect(leadRow(types.slice(0, 4).map((notificationType) => row({ notificationType }))).notificationType).toBe(
      "passed",
    );
    expect(leadRow(types.slice(0, 3).map((notificationType) => row({ notificationType }))).notificationType).toBe(
      "alert",
    );
    expect(leadRow(types.slice(0, 2).map((notificationType) => row({ notificationType }))).notificationType).toBe(
      "new",
    );
  });
});

describe("the payload details the apps' Updates rows read (S4)", () => {
  const action = {
    text: "Reported by the Committee on Energy and Commerce.",
    actionDate: "2026-10-27",
    actionCode: "5000",
  };

  it("an action push names its topic and its action for the Recent actions row", () => {
    expect(
      pushPayloadDetails([row({ notificationType: "alert", subCategory: "Technology", action })], "alert", byBill),
    ).toEqual({
      category: "Bill Alert",
      subCategory: "Technology",
      alert: { text: "Reported by the Committee on Energy and Commerce", actionDate: "2026-10-27", actionCode: "5000" },
    });
  });

  // REL-50: both apps show alert.text as the Recent actions row, so it carries the approved words too (2026-10-29).
  it.each([
    [
      "9000",
      "Failed of passage/not agreed to in House: On motion to suspend the rules and pass the bill Failed by the Yeas and Nays: (2/3 required): 250 - 180 (Roll no. 38).",
      "House vote fell short of two-thirds",
    ],
    [
      "18000",
      "Failed of passage/not agreed to in Senate: Under the order of 9/18/2025, not having achieved 60 votes in the affirmative, failed of passage in Senate by Yea-Nay Vote. 44 - 48. Record Vote Number: 528.",
      "Senate vote fell short of 60",
    ],
  ])(
    "a failed threshold vote (code %s) reaches the Recent actions row in the approved words",
    (actionCode, text, words) => {
      const details = pushPayloadDetails(
        [row({ notificationType: "alert", action: { text, actionDate: "2026-10-27", actionCode } })],
        "alert",
        byBill,
      );
      expect(details.alert).toEqual({ text: words, actionDate: "2026-10-27", actionCode });
    },
  );

  it("an action push without a topic names the category, so the row's topic line never repeats the body", () => {
    expect(pushPayloadDetails([row({ notificationType: "alert", action })], "alert", byBill)).toMatchObject({
      category: "Bill Alert",
      subCategory: "Bill Alert",
    });
    expect(
      pushPayloadDetails(
        [
          row({ notificationType: "alert", category: "", action }),
          row({ notificationType: "alert", billId: "BILLS-119hr78", category: "" }),
        ],
        "alert",
        byBill,
      ).subCategory,
    ).toBe("Bill Alert");
  });

  it("a push about several bills names only what they share, and no single action", () => {
    const details = pushPayloadDetails(
      [
        row({ notificationType: "new", category: "Health", subCategory: "Medical Costs" }),
        row({ notificationType: "new", billId: "BILLS-119hr78", category: "Health", subCategory: "Hospitals" }),
      ],
      "new",
      byBill,
    );
    expect(details).toEqual({ category: "Health" });
  });

  it("a passed push carries its action too; a new or updated push carries none", () => {
    const passed = { text: "Passed/agreed to in House.", actionDate: "2026-10-27", actionCode: "8000" };
    expect(pushPayloadDetails([row({ notificationType: "passed", action: passed })], "passed", byBill).alert).toEqual({
      text: "Passed the House",
      actionDate: "2026-10-27",
      actionCode: "8000",
    });
    expect(pushPayloadDetails([row({ notificationType: "new", subCategory: "Technology" })], "new", byBill)).toEqual({
      category: "Bill Alert",
      subCategory: "Technology",
    });
  });
});

// ─── Through the handler ─────────────────────────────────────────────────────

/** What the mocked command constructors return: the kind of command and the input fields the fakes read. */
interface FakeDynamoCommand {
  kind: string;
  input: {
    TableName?: string;
    RequestItems?: { Pending: Array<{ DeleteRequest: { Key: { billId: { S: string } } } }> };
  };
}
interface FakeSnsCommand {
  input: { Message: string };
}

const originalEnv = { ...process.env };
const mockDynamoSend = jest.fn();
const mockSnsSend = jest.fn();

jest.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: jest.fn(() => ({ send: (cmd: FakeDynamoCommand) => mockDynamoSend(cmd) })),
  GetItemCommand: jest.fn().mockImplementation((input) => ({ input, kind: "GetItem" })),
  QueryCommand: jest.fn().mockImplementation((input) => ({ input, kind: "Query" })),
  UpdateItemCommand: jest.fn().mockImplementation((input) => ({ input, kind: "UpdateItem" })),
  BatchWriteItemCommand: jest.fn().mockImplementation((input) => ({ input, kind: "BatchWriteItem" })),
  DeleteItemCommand: jest.fn().mockImplementation((input) => ({ input, kind: "DeleteItem" })),
}));
jest.mock("@aws-sdk/client-sns", () => ({
  SNSClient: jest.fn(() => ({ send: mockSnsSend })),
  PublishCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

const ENDPOINT = "arn:aws:sns:us-east-1:123:endpoint/APNS/app/phone";

const pendingItem = (
  guid: string,
  type: string,
  extra: Record<string, { S: string }> = {},
): Record<string, { S: string }> => ({
  userId: { S: "user-1" },
  billId: { S: `${guid}#${type}` },
  sourceBillId: { S: guid },
  billTitle: { S: `Title of ${guid}` },
  category: { S: "Bill Alert" },
  lifeArea: { S: "" },
  notificationType: { S: type },
  ...extra,
});

const sqsEvent = (body: unknown): SQSEvent =>
  ({
    Records: [{ messageId: "m-0", body: JSON.stringify(body), attributes: {}, messageAttributes: {} }],
  }) as unknown as SQSEvent;

describe("the pushes userNotifier sends (S4, S5)", () => {
  let restoreEnv: (() => void) | undefined;
  let handler: (event: SQSEvent) => Promise<{ batchItemFailures: unknown[] }>;
  let rows: Record<string, { S: string }>[];
  let publishErrors: Map<string, Error>;
  /** A push listing this bill id fails on every device. */
  let failingBillId: string | undefined;
  let deletedKeys: string[][];

  beforeEach(() => {
    jest.resetModules();
    jest.spyOn(console, "log").mockImplementation();
    jest.spyOn(console, "warn").mockImplementation();
    jest.spyOn(console, "error").mockImplementation();
    restoreEnv = applyTestEnv(
      {
        PENDING_NOTIFICATIONS_TABLE: "Pending",
        PENDING_NOTIFICATIONS_TABLE_PARTITION_KEY: "userId",
        PENDING_NOTIFICATIONS_TABLE_SORT_KEY: "billId",
        DEVICE_TABLE: "Devices",
        USER_ID_ATTRIBUTE: "user_id",
        DEVICE_ID_ATTRIBUTE: "device_id",
      },
      { replace: true, base: originalEnv },
    );
    rows = [];
    publishErrors = new Map();
    failingBillId = undefined;
    deletedKeys = [];
    mockDynamoSend.mockReset();
    mockDynamoSend.mockImplementation(async (cmd: FakeDynamoCommand) => {
      const input = cmd.input;
      if (cmd.kind === "GetItem") return { Item: { markerVersion: { S: "v1" } } };
      if (cmd.kind === "Query" && input.TableName === "Pending") return { Items: rows };
      if (cmd.kind === "Query" && input.TableName === "Devices") {
        return { Items: [{ user_id: { S: "user-1" }, device_id: { S: "phone" }, endpointArn: { S: ENDPOINT } }] };
      }
      if (cmd.kind === "BatchWriteItem") {
        deletedKeys.push(input.RequestItems!.Pending.map((request) => request.DeleteRequest.Key.billId.S));
        return {};
      }
      return {};
    });
    mockSnsSend.mockReset();
    mockSnsSend.mockImplementation(async (cmd: FakeSnsCommand) => {
      const apns = JSON.parse(JSON.parse(cmd.input.Message).APNS);
      const error =
        publishErrors.get(apns.notificationType) ??
        (failingBillId && apns.billIds.includes(failingBillId) ? new Error("Internal error") : undefined);
      if (error) throw error;
      return { MessageId: "m" };
    });
    handler = require("../handlers/userNotifier").handler;
  });

  afterEach(() => {
    restoreEnv?.();
    jest.restoreAllMocks();
  });

  afterAll(() => {
    process.env = originalEnv as NodeJS.ProcessEnv;
  });

  const sent = () =>
    mockSnsSend.mock.calls.map(([cmd]) => {
      const message = JSON.parse(cmd.input.Message);
      return { message, apns: JSON.parse(message.APNS) };
    });

  it("an action push says what happened, and carries what both apps' Recent actions rows show", async () => {
    rows = [
      pendingItem("BILLS-119hr77", "alert", {
        subCategory: { S: "Technology" },
        actionText: { S: "Reported by the Committee on Energy and Commerce." },
        actionDate: { S: "2026-10-27" },
        actionCode: { S: "5000" },
        actionType: { S: "Committee" },
      }),
    ];

    expect(await handler(sqsEvent({ userIds: ["user-1"] }))).toEqual({ batchItemFailures: [] });

    const [{ message, apns }] = sent();
    expect(apns).toEqual({
      aps: {
        alert: {
          title: "Action: Title of BILLS-119hr77",
          body: expect.stringMatching(/^Reported by the Committee on Energy and Commerce · Oct 27(, 2026)?$/),
        },
        sound: "default",
        "thread-id": "bill-digest",
      },
      domain: "bill",
      billId: "BILLS-119hr77",
      billIds: ["BILLS-119hr77"],
      notificationType: "alert",
      category: "Bill Alert",
      subCategory: "Technology",
      alert: { text: "Reported by the Committee on Energy and Commerce", actionDate: "2026-10-27", actionCode: "5000" },
    });
    expect(message.APNS_SANDBOX).toBe(message.APNS);
    expect(message.default).toBe("Action: Title of BILLS-119hr77");
  });

  it("only adds keys the apps read, as strings, and stays well under the 4 KB APNs limit", async () => {
    const long = "Very long text ".repeat(60);
    rows = [
      pendingItem("BILLS-119hr77", "alert", {
        billTitle: { S: long },
        category: { S: long },
        subCategory: { S: long },
        actionText: { S: long },
        actionDate: { S: `2026-10-27${"x".repeat(60)}` },
        actionCode: { S: "9".repeat(60) },
      }),
    ];

    await handler(sqsEvent({ userIds: ["user-1"] }));

    const [{ message, apns }] = sent();
    expect(Object.keys(apns).sort()).toEqual(
      ["aps", "domain", "billId", "billIds", "notificationType", "category", "subCategory", "alert"].sort(),
    );
    expect(Object.keys(apns.alert).sort()).toEqual(["actionCode", "actionDate", "text"]);
    for (const value of [apns.category, apns.subCategory, ...Object.values(apns.alert)]) {
      expect(typeof value).toBe("string");
    }
    expect(Buffer.byteLength(message.APNS, "utf8")).toBeLessThan(1500);
  });

  it("sends the updated rows on a push of their own, typed 'updated', beside the other rows' push", async () => {
    rows = [
      pendingItem("BILLS-119hr1", "updated"),
      pendingItem("BILLS-119hr2", "updated"),
      pendingItem("BILLS-119hr3", "alert", { actionText: { S: "Referred to the Committee on Finance." } }),
      pendingItem("BILLS-119hr4", "new"),
    ];

    await handler(sqsEvent({ userIds: ["user-1"] }));

    expect(sent().map(({ apns }) => [apns.aps.alert.title, apns.notificationType, apns.billIds])).toEqual([
      ["2 Bill Updates", "digest", ["BILLS-119hr3", "BILLS-119hr4"]],
      ["2 Bills Changed", "updated", ["BILLS-119hr1", "BILLS-119hr2"]],
    ]);
    expect(deletedKeys).toEqual([
      ["BILLS-119hr1#updated", "BILLS-119hr2#updated", "BILLS-119hr3#alert", "BILLS-119hr4#new"],
    ]);
  });

  // F1: both apps ask to vote again only on the ids a push lists (at most 50, PushPayloadLimits.maxBillIds in 1.1 and
  // 1.2), and every row is deleted once its push is sent, so an updated push lists every bill it covers.
  const updatedRows = (count: number, guidOf = (n: number) => `BILLS-119hr${1000 + n}`) =>
    Array.from({ length: count }, (_, n) => pendingItem(guidOf(n), "updated"));
  const guidsOf = (items: Record<string, { S: string }>[]) => items.map((item) => item.sourceBillId.S);

  it("lists every bill on an updated push of more than 8 bills", async () => {
    rows = updatedRows(12);

    await handler(sqsEvent({ userIds: ["user-1"] }));

    const [{ message, apns }] = sent();
    expect(sent()).toHaveLength(1);
    expect(apns).toMatchObject({ notificationType: "updated", billCount: 12, billIds: guidsOf(rows) });
    expect(apns.aps.alert.title).toBe("12 Bills Changed");
    expect(Buffer.byteLength(message.APNS, "utf8")).toBeLessThan(1500);
  });

  it("puts more than 50 updated bills on several updated pushes that list each bill once", async () => {
    rows = updatedRows(120);

    expect(await handler(sqsEvent({ userIds: ["user-1"] }))).toEqual({ batchItemFailures: [] });

    expect(sent().map(({ apns }) => [apns.aps.alert.title, apns.notificationType, apns.billIds.length])).toEqual([
      ["50 Bills Changed", "updated", 50],
      ["50 Bills Changed", "updated", 50],
      ["20 Bills Changed", "updated", 20],
    ]);
    expect(sent().flatMap(({ apns }) => apns.billIds)).toEqual(guidsOf(rows));
    for (const { message } of sent()) expect(Buffer.byteLength(message.APNS, "utf8")).toBeLessThanOrEqual(3500);
    expect(deletedKeys.flat()).toHaveLength(120);
  });

  it("splits updated bills whose ids do not fit one payload, so no id is dropped", async () => {
    // 64 characters, the longest guid either app accepts (BillGuid.maxLength): 50 of them do not fit 3.5 KB.
    const longGuid = (n: number) => `BILLS-119hr${1000 + n}`.padEnd(64, "a");
    rows = updatedRows(50, longGuid);

    await handler(sqsEvent({ userIds: ["user-1"] }));

    expect(sent().length).toBeGreaterThan(1);
    expect(sent().every(({ apns }) => apns.notificationType === "updated")).toBe(true);
    expect(sent().flatMap(({ apns }) => apns.billIds)).toEqual(guidsOf(rows));
    for (const { message } of sent()) expect(Buffer.byteLength(message.APNS, "utf8")).toBeLessThanOrEqual(3500);
  });

  it("keeps only the rows of the updated push that failed, when another updated push went out", async () => {
    rows = updatedRows(60);
    failingBillId = "BILLS-119hr1055";

    const result = await handler(sqsEvent({ userIds: ["user-1"] }));

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: "m-0" }] });
    expect(sent().map(({ apns }) => apns.billIds.length)).toEqual([50, 10]);
    expect(deletedKeys.flat()).toEqual(guidsOf(rows.slice(0, 50)).map((guid) => `${guid}#updated`));
    expect(mockDynamoSend.mock.calls.filter(([cmd]) => cmd.kind === "DeleteItem")).toEqual([]);
  });

  // F2: both apps take an alert push down their single-alert path, which opens and files a row for its first id only.
  it("sends several bills' actions as a digest that lists every bill, with no single action", async () => {
    rows = [
      pendingItem("BILLS-119hr1", "alert", { actionText: { S: "Referred to the Committee on Finance." } }),
      pendingItem("BILLS-119hr2", "alert", { actionText: { S: "Reported by the Committee on Rules." } }),
    ];

    await handler(sqsEvent({ userIds: ["user-1"] }));

    const [{ apns }] = sent();
    expect(apns).toEqual({
      aps: {
        alert: { title: "Action on 2 Bills", body: "Includes Title of BILLS-119hr1 and Title of BILLS-119hr2." },
        sound: "default",
        "thread-id": "bill-digest",
      },
      domain: "bill",
      billIds: ["BILLS-119hr1", "BILLS-119hr2"],
      billCount: 2,
      notificationType: "digest",
      category: "Bill Alert",
    });
  });

  it("keeps the rows of a push that failed on every device for the retry, and deletes the rows that went out", async () => {
    rows = [pendingItem("BILLS-119hr1", "updated"), pendingItem("BILLS-119hr3", "new")];
    publishErrors.set("updated", Object.assign(new Error("Internal error"), { name: "InternalErrorException" }));

    const result = await handler(sqsEvent({ userIds: ["user-1"] }));

    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: "m-0" }] });
    expect(deletedKeys).toEqual([["BILLS-119hr3#new"]]);
    // The dispatch marker and claim stay, so the retry finds the updated row.
    expect(mockDynamoSend.mock.calls.filter(([cmd]) => cmd.kind === "DeleteItem")).toEqual([]);
  });
});
