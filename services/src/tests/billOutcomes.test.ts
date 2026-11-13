import {
  BECAME_LAW_TEXT,
  billOutcomeKindForAction,
  billOutcomeTextForAction,
  billStatusForOutcome,
  deriveBillStatusFromActions,
  FAILED_SIXTY_VOTES_TEXT,
  FAILED_SUSPENSION_TEXT,
  firstBillOutcomeDate,
  isBillFailureAction,
  isEnactmentAction,
  latestBillOutcomeAction,
  latestEnactmentAction,
  latestNewBillOutcomeAction,
  newBillActions,
  normalizeBillActionKey,
  notBillFailureReason,
} from "../shared/billOutcomes";

describe("billOutcomes", () => {
  it("derives Failed when the most recent decisive vote is a failed vote", () => {
    const actions = [
      {
        actionCode: "8000",
        actionDate: "2026-01-15",
        text: "Passed/agreed to in House",
        type: "Floor",
      },
      {
        actionCode: "18000",
        actionDate: "2026-02-01",
        text: "Failed of passage in Senate",
        type: "Floor",
      },
    ];

    expect(latestBillOutcomeAction(actions)).toEqual(
      expect.objectContaining({
        kind: "failed",
        actionCode: "18000",
      }),
    );
    expect(deriveBillStatusFromActions(actions)).toBe("Failed");
  });

  it("derives Passed when a later passage vote supersedes an older failed vote", () => {
    const actions = [
      {
        actionCode: "9000",
        actionDate: "2026-02-01",
        text: "Failed of passage in House",
        type: "Floor",
      },
      {
        actionCode: "17000",
        actionDate: "2026-03-01",
        text: "Passed Senate",
        type: "Floor",
      },
    ];

    expect(latestBillOutcomeAction(actions)).toEqual(
      expect.objectContaining({
        kind: "passed",
        actionCode: "17000",
      }),
    );
    expect(deriveBillStatusFromActions(actions)).toBe("Passed");
  });

  it("finds only newly-added failed outcomes when diffing versions", () => {
    const previousActions = [
      {
        actionCode: "H11100",
        actionDate: "2026-01-01",
        text: "Referred to the House Committee on Education and Workforce.",
        type: "IntroReferral",
      },
    ];

    const currentActions = [
      ...previousActions,
      {
        actionCode: "9000",
        actionDate: "2026-02-10",
        text: "Failed of passage in House: Failed by the Yeas and Nays: 180 - 250.",
        type: "Floor",
      },
    ];

    expect(latestNewBillOutcomeAction(previousActions, currentActions)).toEqual(
      expect.objectContaining({
        kind: "failed",
        actionCode: "9000",
      }),
    );
  });

  describe("FAILED comes from the bill's own failure, by action code (REL-50, feature review S7)", () => {
    // Lines as congress.gov's action list has them: the Library of Congress milestone with its code, the House's floor
    // line with its H-code, and the Senate's own line, which has none.
    const LIVE_BILL = [
      {
        actionCode: "17000",
        actionDate: "2026-06-30",
        text: "Passed/agreed to in Senate: Passed Senate with an amendment by Yea-Nay Vote. 51 - 49. Record Vote Number: 372.",
        type: "Floor",
        sourceSystem: { code: 9, name: "Library of Congress" },
      },
      {
        actionCode: "8000",
        actionDate: "2026-05-22",
        text: "Passed/agreed to in House: On passage Passed by recorded vote: 215 - 214 (Roll no. 145).",
        type: "Floor",
      },
      {
        actionCode: "H11100",
        actionDate: "2026-05-16",
        text: "Referred to the House Committee on the Budget.",
        type: "IntroReferral",
      },
    ];
    const senateLine = (text: string, actionDate = "2026-07-01") => ({
      actionDate,
      text,
      type: "Floor",
      sourceSystem: { code: 0, name: "Senate" },
    });

    it.each<[string, Record<string, unknown>, string]>([
      [
        "an amendment the Senate rejected",
        senateLine("Amendment SA 2360 not agreed to in Senate by Yea-Nay Vote. 47 - 53. Record Vote Number: 381."),
        "amendment",
      ],
      [
        "a motion to waive",
        senateLine(
          "Motion to waive all applicable budgetary discipline with respect to amendment SA 2405 not agreed to in Senate by Yea-Nay Vote. 45 - 54.",
        ),
        "motion",
      ],
      [
        "a motion to proceed",
        senateLine(
          "Motion to proceed to consideration of measure not agreed to in Senate by Yea-Nay Vote. 48 - 50. Record Vote Number: 210.",
        ),
        "motion",
      ],
      [
        "a motion to commit",
        senateLine(
          "Motion by Senator Smith to commit to Senate Committee on Finance with instructions not agreed to in Senate by Yea-Nay Vote. 46 - 53.",
        ),
        "motion",
      ],
      [
        "cloture",
        senateLine("Cloture on the motion to proceed to the measure not invoked in Senate by Yea-Nay Vote. 52 - 47."),
        "motion",
      ],
      [
        "cloture on the bill",
        senateLine("Cloture on the measure not invoked in Senate by Yea-Nay Vote. 55 - 45. Record Vote Number: 300."),
        "cloture",
      ],
      [
        "a conference report",
        senateLine("Conference report not agreed to in Senate by Yea-Nay Vote. 48 - 52."),
        "conferenceReport",
      ],
      [
        "a motion to recommit",
        {
          actionCode: "H38310",
          actionDate: "2026-07-01",
          text: "On motion to recommit Failed by the Yeas and Nays: 201 - 215 (Roll no. 301).",
          type: "Floor",
        },
        "otherCode",
      ],
      [
        "a House amendment failed in the Committee of the Whole",
        {
          actionCode: "77000",
          actionDate: "2026-07-01",
          text: "Amendment failed of passage in Committee of the Whole.",
          type: "Floor",
        },
        "otherCode",
      ],
      [
        "a failed suspension vote (the House can take the bill up again under a rule)",
        {
          actionCode: "9000",
          actionDate: "2026-07-01",
          text: "Failed of passage/not agreed to in House: On motion to suspend the rules and pass the bill, as amended Failed by the Yeas and Nays: (2/3 required): 250 - 180 (Roll no. 38).",
          type: "Floor",
        },
        "suspension",
      ],
      [
        "the floor line of that suspension vote",
        {
          actionCode: "H37300",
          actionDate: "2026-07-01",
          text: "On motion to suspend the rules and pass the bill, as amended Failed by the Yeas and Nays: (2/3 required): 250 - 180 (Roll no. 38).",
          type: "Floor",
        },
        "otherCode",
      ],
      [
        "a failure code on a motion line",
        {
          actionCode: "18000",
          actionDate: "2026-07-01",
          text: "Failed of passage/not agreed to in Senate: Motion to proceed to consideration of measure not agreed to in Senate.",
          type: "Floor",
        },
        "motion",
      ],
      [
        "a point of order",
        senateLine("Failed of passage in Senate: point of order raised against the measure sustained."),
        "pointOfOrder",
      ],
      [
        "the old text pattern elsewhere in a line",
        senateLine("Senate failed in the Senate to agree to the request."),
        "uncoded",
      ],
      [
        "the Senate's own line of the bill's failure, before the Library of Congress codes it",
        senateLine("Failed of passage in Senate by Yea-Nay Vote. 45 - 55. Record Vote Number: 99."),
        "uncoded",
      ],
      [
        "a Senate vote under a 60-vote order (H.R. 5371, 2025-09-19: it became law on 2025-11-12)",
        {
          actionCode: "18000",
          actionDate: "2026-07-01",
          text: "Failed of passage/not agreed to in Senate: Under the order of 9/18/2025, not having achieved 60 votes in the affirmative, failed of passage in Senate by Yea-Nay Vote. 44 - 48. Record Vote Number: 528.",
          type: "Floor",
        },
        "sixtyVotes",
      ],
      [
        "the same vote taken again on reconsideration (H.R. 5371, 2025-09-30)",
        {
          actionCode: "18000",
          actionDate: "2026-07-01",
          text: "Failed of passage/not agreed to in Senate: Upon reconsideration, under the order of 9/18/2025, not having achieved 60 votes in the affirmative, failed of passage in Senate by Yea-Nay Vote. 55 - 45. Record Vote Number: 535.",
          type: "Floor",
        },
        "sixtyVotes",
      ],
      [
        "the Senate's own line of a 60-vote failure",
        senateLine(
          "Upon reconsideration, not having achieved 60 votes in the affirmative, failed of passage in Senate by Yea-Nay Vote. 55 - 45.",
        ),
        "sixtyVotes",
      ],
      [
        "a vote that needed three fifths of the Senate",
        {
          actionCode: "18000",
          actionDate: "2026-07-01",
          text: "Failed of passage/not agreed to in Senate: Three-fifths of the Senators duly chosen and sworn not having voted in the affirmative, the bill failed of passage by Yea-Nay Vote. 57 - 43.",
          type: "Floor",
        },
        "sixtyVotes",
      ],
    ])("never stamps a live bill FAILED for %s", (_name, line, reason) => {
      const actions = [line, ...LIVE_BILL];
      expect(notBillFailureReason(line)).toBe(reason);
      expect(isBillFailureAction(line)).toBe(false);
      expect(billOutcomeKindForAction(line)).toBeNull();
      expect(deriveBillStatusFromActions(actions)).toBe("Passed");
      expect(latestNewBillOutcomeAction(LIVE_BILL, actions)).toBeNull();
      expect(firstBillOutcomeDate([line])).toBeNull();
    });

    it("leaves a bill New after a failed suspension vote, so it stays on the Bills list", () => {
      const actions = [
        {
          actionCode: "9000",
          actionDate: "2024-02-06",
          text: "Failed of passage/not agreed to in House: On motion to suspend the rules and pass the bill Failed by the Yeas and Nays: (2/3 required): 250 - 180 (Roll no. 38).",
          type: "Floor",
        },
        {
          actionCode: "H11100",
          actionDate: "2024-02-03",
          text: "Referred to the House Committee on Appropriations.",
          type: "IntroReferral",
        },
      ];
      expect(deriveBillStatusFromActions(actions)).toBe("New");
      expect(billOutcomeTextForAction(actions[0])).toBe(FAILED_SUSPENSION_TEXT);
      expect(FAILED_SUSPENSION_TEXT).toBe("House vote fell short of two-thirds");
    });

    it.each<[string, Record<string, unknown>, string]>([
      [
        "a House passage vote (9000, under a rule)",
        {
          actionCode: "9000",
          text: "Failed of passage/not agreed to in House: On passage Failed by the Yeas and Nays: 202 - 220 (Roll no. 450).",
        },
        "Failed in the House",
      ],
      [
        "a resolution the House rejected",
        {
          actionCode: "9000",
          text: "Failed of passage/not agreed to in House On agreeing to the resolution Failed by recorded vote: 214 - 217 (Roll no. 60).",
        },
        "Failed in the House",
      ],
      [
        "a Senate passage vote (18000, a simple majority)",
        {
          actionCode: "18000",
          text: "Failed of passage/not agreed to in Senate: Failed of passage in Senate by Yea-Nay Vote. 45 - 55. Record Vote Number: 99.",
        },
        "Failed in the Senate",
      ],
      [
        "a resolution the Senate rejected without amendment",
        {
          actionCode: "18000",
          text: "Failed of passage/not agreed to in Senate: Resolution not agreed to in Senate without amendment by Yea-Nay Vote. 45 - 52.",
        },
        "Failed in the Senate",
      ],
      [
        "a constitutional amendment short of two thirds (a vote on the joint resolution itself)",
        {
          actionCode: "9000",
          text: "Failed of passage/not agreed to in House: On passage of the joint resolution proposing an amendment to the Constitution Failed by the Yeas and Nays: (2/3 required): 261 - 170 (Roll no. 112).",
        },
        "Failed in the House",
      ],
      [
        "a failed override in the House (33000)",
        {
          actionCode: "33000",
          text: "Failed of passage in House over veto by the Yeas and Nays: (2/3 required): 260 - 170.",
        },
        "House failed to override the veto",
      ],
      [
        "a failed override in the Senate (35000)",
        { actionCode: "35000", text: "Failed of passage in Senate over veto by Yea-Nay Vote. 54 - 46." },
        "Senate failed to override the veto",
      ],
    ])("stamps FAILED for %s", (_name, line, words) => {
      const action = { actionDate: "2026-07-02", type: "Floor", ...line };
      expect(notBillFailureReason(action)).toBeNull();
      expect(deriveBillStatusFromActions([action, ...LIVE_BILL])).toBe("Failed");
      expect(latestNewBillOutcomeAction(LIVE_BILL, [action, ...LIVE_BILL])).toEqual(
        expect.objectContaining({ kind: "failed", actionCode: line.actionCode }),
      );
      expect(billOutcomeTextForAction(action)).toBe(words);
    });

    it("waits for the Library of Congress code of a failure, as passage does (one vote, one failure)", () => {
      const uncoded = senateLine("Failed of passage in Senate by Yea-Nay Vote. 45 - 55. Record Vote Number: 99.");
      const coded = {
        ...uncoded,
        actionCode: "18000",
        text: `Failed of passage/not agreed to in Senate: ${uncoded.text}`,
        sourceSystem: { code: 9, name: "Library of Congress" },
      };
      expect(isBillFailureAction(uncoded)).toBe(false);
      expect(isBillFailureAction(senateLine("Failed of passage in Senate with an amendment by Voice Vote."))).toBe(
        false,
      );
      expect(deriveBillStatusFromActions([uncoded, ...LIVE_BILL])).toBe("Passed");
      // No code: the push says it in Congress's words.
      expect(billOutcomeTextForAction(uncoded)).toBeNull();
      // The coded line, in the same version or a later one, is the bill's one failure.
      expect(latestNewBillOutcomeAction(LIVE_BILL, [uncoded, ...LIVE_BILL])).toBeNull();
      expect(latestNewBillOutcomeAction([uncoded, ...LIVE_BILL], [coded, uncoded, ...LIVE_BILL])).toEqual(
        expect.objectContaining({ kind: "failed", actionCode: "18000" }),
      );
      expect(deriveBillStatusFromActions([coded, uncoded, ...LIVE_BILL])).toBe("Failed");
    });

    it("keeps a bill's status after a failed 60-vote Senate vote, and says it in plain words (H.R. 5371)", () => {
      // H.R. 5371 (FY2026 continuing resolution): passed the House 2025-09-19, failed twice in the Senate under the
      // order of 9/18/2025, passed the Senate 60 - 40 on 2025-11-10 and became Public Law 119-37 on 2025-11-12.
      const passedHouse = {
        actionCode: "8000",
        actionDate: "2025-09-19",
        text: "Passed/agreed to in House: On passage Passed by the Yeas and Nays: 217 - 212 (Roll no. 281).",
        type: "Floor",
      };
      const failed = (actionDate: string, text: string) => [
        { actionCode: "18000", actionDate, text: `Failed of passage/not agreed to in Senate: ${text}`, type: "Floor" },
        { actionDate, text, type: "Floor", sourceSystem: { code: 0, name: "Senate" } },
      ];
      const first = failed(
        "2025-09-19",
        "Under the order of 9/18/2025, not having achieved 60 votes in the affirmative, failed of passage in Senate by Yea-Nay Vote. 44 - 48. Record Vote Number: 528.",
      );
      const second = failed(
        "2025-09-30",
        "Upon reconsideration, under the order of 9/18/2025, not having achieved 60 votes in the affirmative, failed of passage in Senate by Yea-Nay Vote. 55 - 45. Record Vote Number: 535.",
      );
      const passedSenate = {
        actionCode: "17000",
        actionDate: "2025-11-10",
        text: "Passed/agreed to in Senate: Passed Senate with an amendment by Yea-Nay Vote. 60 - 40. Record Vote Number: 618.",
        type: "Floor",
      };
      expect(deriveBillStatusFromActions([...first, passedHouse])).toBe("Passed");
      expect(deriveBillStatusFromActions([...second, ...first, passedHouse])).toBe("Passed");
      expect(latestNewBillOutcomeAction([passedHouse], [...first, passedHouse])).toBeNull();
      expect(latestNewBillOutcomeAction([...first, passedHouse], [...second, ...first, passedHouse])).toBeNull();
      expect(
        latestNewBillOutcomeAction(
          [...second, ...first, passedHouse],
          [passedSenate, ...second, ...first, passedHouse],
        ),
      ).toEqual(expect.objectContaining({ kind: "passed", actionCode: "17000" }));
      for (const line of [...first, ...second]) expect(billOutcomeTextForAction(line)).toBe(FAILED_SIXTY_VOTES_TEXT);
      expect(FAILED_SIXTY_VOTES_TEXT).toBe("Senate vote fell short of 60");
      // A motion or cloture that needed 60 votes keeps Congress's words (and its reason).
      const cloture = {
        actionDate: "2025-10-01",
        text: "Cloture on the motion to proceed to the measure not invoked in Senate by Yea-Nay Vote. 55 - 45. Record Vote Number: 545.",
        type: "Floor",
      };
      expect(notBillFailureReason(cloture)).toBe("motion");
      expect(billOutcomeTextForAction(cloture)).toBeNull();
    });

    it("trusts the code over the text: another code never fails the bill, and passage needs a passage code", () => {
      expect(billOutcomeKindForAction({ actionCode: "95000", text: "Failed of passage in Senate." })).toBeNull();
      expect(
        billOutcomeKindForAction({
          actionCode: "8000",
          text: "Passed/agreed to in House: On motion to suspend the rules and pass the bill Agreed to by voice vote.",
        }),
      ).toBe("passed");
      expect(billOutcomeKindForAction({ text: "Passed Senate without amendment by Unanimous Consent." })).toBeNull();
      expect(billOutcomeKindForAction(null)).toBeNull();
      expect(billOutcomeKindForAction({ actionCode: "9000" })).toBe("failed");
    });

    it("can report by another rule (the status repair reads what the rule before REL-50 stamped)", () => {
      const amendment = senateLine("Amendment SA 2360 not agreed to in Senate by Yea-Nay Vote. 47 - 53.");
      const textRule = (action: unknown) =>
        /not agreed to in (?:the )?(house|senate)/i.test(String((action as { text?: unknown }).text)) ? "failed" : null;
      expect(latestBillOutcomeAction([amendment, ...LIVE_BILL], textRule)).toEqual(
        expect.objectContaining({ kind: "failed", actionDate: "2026-07-01" }),
      );
      expect(billStatusForOutcome(latestBillOutcomeAction([amendment, ...LIVE_BILL], textRule))).toBe("Failed");
      expect(billStatusForOutcome(latestBillOutcomeAction([amendment, ...LIVE_BILL]))).toBe("Passed");
      expect(billStatusForOutcome(null)).toBe("New");
    });
  });

  describe("firstBillOutcomeDate (INT-11)", () => {
    it("is the earliest dated passage or failure action, whatever the order or the later outcomes", () => {
      expect(
        firstBillOutcomeDate([
          { actionCode: "17000", actionDate: "2026-03-02", text: "Passed Senate" },
          { actionCode: "H11100", actionDate: "2026-01-02", text: "Referred to committee" },
          { actionCode: "9000", actionDate: "2026-02-10T00:00:00Z", text: "Failed of passage in House" },
          { actionDate: "2026-02-20", text: "Motion to proceed not agreed to in Senate" },
        ]),
      ).toBe("2026-02-10");
    });

    it("is null without a dated outcome action", () => {
      expect(
        firstBillOutcomeDate([{ actionDate: "2026-02-20", text: "Motion to proceed not agreed to in Senate" }]),
      ).toBeNull();
      expect(firstBillOutcomeDate(undefined)).toBeNull();
      expect(firstBillOutcomeDate([{ actionCode: "H11100", actionDate: "2026-01-02", text: "Referred" }])).toBeNull();
      expect(firstBillOutcomeDate([{ actionCode: "8000", text: "Passed House" }, null])).toBeNull();
      expect(firstBillOutcomeDate([{ actionCode: "8000", actionDate: "March 2", text: "Passed House" }])).toBeNull();
    });
  });
});

// REL-44: real action lines from processed bills (actionCode, actionDate, text, type as congress.gov returns them).
const HJRES131_LAW = [
  { actionCode: "E40000", actionDate: "2025-12-11", text: "Became Public Law No: 119-52.", type: "President" },
  { actionCode: "36000", actionDate: "2025-12-11", text: "Became Public Law No: 119-52.", type: "BecameLaw" },
  { actionCode: "E30000", actionDate: "2025-12-11", text: "Signed by President.", type: "President" },
  { actionCode: "36000", actionDate: "2025-12-11", text: "Signed by President.", type: "BecameLaw" },
  { actionCode: "E20000", actionDate: "2025-12-10", text: "Presented to President.", type: "Floor" },
  { actionCode: "28000", actionDate: "2025-12-10", text: "Presented to President.", type: "President" },
  {
    actionCode: "17000",
    actionDate: "2025-12-04",
    text: "Passed/agreed to in Senate: Passed Senate without amendment by Yea-Nay Vote. 49 - 45. Record Vote Number: 632.",
    type: "Floor",
  },
  {
    actionCode: "8000",
    actionDate: "2025-11-18",
    actionTime: "20:52:55",
    text: "Passed/agreed to in House: On passage Passed by the Yeas and Nays: 217 - 209 (Roll no. 295). (text: CR H4750)",
    type: "Floor",
  },
  { actionCode: "1000", actionDate: "2025-10-10", text: "Introduced in House", type: "IntroReferral" },
];

// The steps before a law: passed both chambers and presented (H.R. 224, still waiting in the stored data).
const HR224_PRESENTED = [
  { actionCode: "E20000", actionDate: "2026-01-13", text: "Presented to President.", type: "Floor" },
  { actionCode: "28000", actionDate: "2026-01-13", text: "Presented to President.", type: "President" },
  {
    actionCode: "17000",
    actionDate: "2026-01-06",
    text: "Passed/agreed to in Senate: Passed Senate without amendment by Unanimous Consent.",
    type: "Floor",
  },
  {
    actionCode: "8000",
    actionDate: "2025-02-10",
    text: "Passed/agreed to in House: On motion to suspend the rules and pass the bill Agreed to by voice vote. (text: CR H593)",
    type: "Floor",
  },
  { actionCode: "1000", actionDate: "2025-01-07", text: "Introduced in House", type: "IntroReferral" },
];

// H.R. 131: vetoed, and the House failed to override.
const HR131_VETOED = [
  {
    actionCode: "33000",
    actionDate: "2026-01-08",
    text: "Failed of passage in House over veto On passage, the objections of the President to the contrary notwithstanding Failed by the Yeas and Nays: (2/3 required): 248 - 177, 1 Present (Roll no. 9).",
    type: "Veto",
  },
  { actionCode: "E30000", actionDate: "2025-12-29", text: "Vetoed by President.", type: "President" },
  { actionCode: "31000", actionDate: "2025-12-29", text: "Vetoed by President.", type: "President" },
  { actionCode: "E20000", actionDate: "2025-12-18", text: "Presented to President.", type: "Floor" },
  { actionCode: "28000", actionDate: "2025-12-18", text: "Presented to President.", type: "President" },
  {
    actionCode: "17000",
    actionDate: "2025-12-16",
    text: "Passed/agreed to in Senate: Passed Senate without amendment by Voice Vote.",
    type: "Floor",
  },
  {
    actionCode: "8000",
    actionDate: "2025-07-21",
    text: "Passed/agreed to in House: On motion to suspend the rules and pass the bill, as amended Agreed to by voice vote. (text: CR H3497-3498)",
    type: "Floor",
  },
];

describe("billOutcomes: Finalized (REL-44)", () => {
  it("derives Finalized for a bill that became law (H.J.Res. 131) and names the law action", () => {
    expect(deriveBillStatusFromActions(HJRES131_LAW)).toBe("Finalized");
    expect(latestEnactmentAction(HJRES131_LAW)).toEqual({
      actionCode: "E40000",
      actionDate: "2025-12-11",
      actionType: "President",
      text: "Became Public Law No: 119-52.",
    });
    // The passage is still the latest outcome action, the one notificationType pushes "passed" for.
    expect(latestBillOutcomeAction(HJRES131_LAW)).toEqual(
      expect.objectContaining({ kind: "passed", actionCode: "17000" }),
    );
  });

  it("keeps Finalized whatever the order of the same-day actions", () => {
    expect(deriveBillStatusFromActions([...HJRES131_LAW].reverse())).toBe("Finalized");
  });

  it.each([
    [
      "E40000, the House's law line",
      { actionCode: "E40000", actionDate: "2025-12-01", text: "Became Public Law No: 119-44.", type: "President" },
    ],
    [
      "36000 without a period (H.R. 2483)",
      { actionCode: "36000", actionDate: "2025-12-01", text: "Became Public Law No: 119-44", type: "BecameLaw" },
    ],
    [
      "36000 signed by the President",
      { actionCode: "36000", actionDate: "2025-01-29", text: "Signed by President.", type: "BecameLaw" },
    ],
    [
      "a private law (36000)",
      { actionCode: "36000", actionDate: "2026-02-02", text: "Became Private Law No: 119-1.", type: "BecameLaw" },
    ],
    [
      "the BecameLaw type without a code",
      { actionDate: "2025-01-29", text: "Became Public Law No: 119-1.", type: "BecameLaw" },
    ],
  ])("counts %s as becoming law, in plain words", (_label, action) => {
    expect(isEnactmentAction(action)).toBe(true);
    expect(deriveBillStatusFromActions([action, ...HR224_PRESENTED])).toBe("Finalized");
    expect(billOutcomeTextForAction(action)).toBe(BECAME_LAW_TEXT);
    // A law line is not a passage or a failure: no "passed" or "failed" push of its own.
    expect(billOutcomeKindForAction(action)).toBeNull();
  });

  it("derives Finalized for a law without the President's signature only once the law line arrives (H.R. 6644)", () => {
    const unsigned = [
      {
        actionCode: "E30000",
        actionDate: "2026-07-11",
        text: "Sent to Archivist of the United States unsigned.",
        type: "President",
      },
      ...HR224_PRESENTED,
    ];
    expect(deriveBillStatusFromActions(unsigned)).toBe("Passed");
    const law = [
      { actionCode: "E40000", actionDate: "2026-07-11", text: "Became Public Law No: 119-101.", type: "President" },
      { actionCode: "36000", actionDate: "2026-07-11", text: "Became Public Law No: 119-101.", type: "BecameLaw" },
      ...unsigned,
    ];
    expect(deriveBillStatusFromActions(law)).toBe("Finalized");
  });

  it("derives Finalized after a veto override once the law line arrives", () => {
    const overridden = [
      {
        actionDate: "2026-03-02",
        text: "Passed Senate over veto by Yea-Nay Vote. 70 - 28. Record Vote Number: 41.",
        type: "Veto",
      },
      {
        actionDate: "2026-02-20",
        text: "On passage, the objections of the President to the contrary notwithstanding Passed by the Yeas and Nays: (2/3 required): 310 - 110 (Roll no. 60).",
        type: "Veto",
      },
      { actionCode: "31000", actionDate: "2026-02-10", text: "Vetoed by President.", type: "President" },
      ...HR224_PRESENTED,
    ];
    expect(deriveBillStatusFromActions(overridden)).toBe("Passed");
    const law = [
      { actionCode: "E40000", actionDate: "2026-03-03", text: "Became Public Law No: 119-80.", type: "President" },
      ...overridden,
    ];
    expect(deriveBillStatusFromActions(law)).toBe("Finalized");
  });

  it("never derives Finalized for a vetoed bill: Passed until a failed override makes it Failed (H.R. 131)", () => {
    expect(deriveBillStatusFromActions(HR131_VETOED)).toBe("Failed");
    expect(deriveBillStatusFromActions(HR131_VETOED.slice(1))).toBe("Passed");
    expect(HR131_VETOED.some(isEnactmentAction)).toBe(false);
  });

  it("keeps Passed for a bill presented to the President and not yet signed (H.R. 224)", () => {
    expect(deriveBillStatusFromActions(HR224_PRESENTED)).toBe("Passed");
    expect(latestEnactmentAction(HR224_PRESENTED)).toBeNull();
  });

  it("keeps Passed for resolutions that never become law", () => {
    // S.Res. 138: a simple resolution agreed to in its chamber.
    const simple = [
      {
        actionCode: "17000",
        actionDate: "2025-03-25",
        text: "Passed/agreed to in Senate: Submitted in the Senate, considered, and agreed to without amendment and with a preamble by Unanimous Consent.",
        type: "Floor",
      },
      { actionCode: "10000", actionDate: "2025-03-25", text: "Introduced in Senate", type: "IntroReferral" },
    ];
    // H.Con.Res. 109: a concurrent resolution agreed to in both chambers.
    const concurrent = [
      {
        actionCode: "17000",
        actionDate: "2026-06-16",
        text: "Passed/agreed to in Senate: Resolution agreed to in Senate without amendment by Unanimous Consent.",
        type: "Floor",
      },
      {
        actionCode: "8000",
        actionDate: "2026-06-11",
        text: "Passed/agreed to in House: On agreeing to the resolution Agreed to without objection. (text: CR H4099-4100)",
        type: "Floor",
      },
    ];
    // A joint resolution proposing a constitutional amendment goes to the states, not to the President.
    const amendment = [
      {
        actionCode: "17000",
        actionDate: "2026-05-05",
        text: "Passed/agreed to in Senate: Passed Senate without amendment by Yea-Nay Vote. 69 - 30. Record Vote Number: 120.",
        type: "Floor",
      },
      {
        actionCode: "8000",
        actionDate: "2026-04-21",
        text: "Passed/agreed to in House: On passage Passed by the Yeas and Nays: (2/3 required): 300 - 125 (Roll no. 140).",
        type: "Floor",
      },
    ];
    for (const actions of [simple, concurrent, amendment]) expect(deriveBillStatusFromActions(actions)).toBe("Passed");
  });

  it.each([
    ["the House's E30000 signature line alone", { actionCode: "E30000", text: "Signed by President." }],
    ["the law text without its code", { text: "Became Public Law No: 119-1." }],
    ["a private law's text without its code", { text: "Became Private Law No: 119-1." }],
    ["the Senate's enrolling signature", { text: "Signed by President pro tempore of the Senate." }],
    ["the Speaker's signature", { actionCode: "H15000", text: "Signed by Speaker of the House." }],
    [
      "a mention of another bill's law",
      {
        actionCode: "H15000",
        text: "Provisions of this measure were incorporated into H.R. 1, which became Public Law No: 119-21.",
      },
    ],
    ["the presentment", { actionCode: "28000", text: "Presented to President." }],
    ["the veto", { actionCode: "31000", text: "Vetoed by President." }],
  ])("does not count %s as becoming law (REL-50: codes, never text alone)", (_label, line) => {
    const action = { actionDate: "2026-01-14", type: "Floor", ...line };
    expect(isEnactmentAction(action)).toBe(false);
    expect(deriveBillStatusFromActions([action, ...HR224_PRESENTED])).toBe("Passed");
    expect(billOutcomeTextForAction(action)).toBeNull();
  });

  it("derives New without outcome actions, and ignores empty and malformed entries", () => {
    expect(deriveBillStatusFromActions(undefined)).toBe("New");
    expect(deriveBillStatusFromActions(null)).toBe("New");
    expect(deriveBillStatusFromActions([null, {}, "text", { text: 7 }])).toBe("New");
    expect(isEnactmentAction(null)).toBe(false);
    expect(isEnactmentAction("36000")).toBe(false);
    expect(latestEnactmentAction(undefined)).toBeNull();
  });

  it("finds no new passed or failed outcome when only the law lines are new (no 'passed' push for a law)", () => {
    expect(latestNewBillOutcomeAction(HR224_PRESENTED, [...HJRES131_LAW.slice(0, 4), ...HR224_PRESENTED])).toBeNull();
  });
});

describe("billOutcomes: Congressional Record citations are no new action (project decision 2026-11-12)", () => {
  // congress.gov's lines as stored, before and after it added a citation to them days or months later.
  const HR9614_PASSAGE = {
    actionCode: "8000",
    actionDate: "2026-11-09",
    text: "Passed/agreed to in House: On motion to suspend the rules and pass the bill Agreed to by voice vote.",
    type: "Floor",
  };
  const HR9614_CONSIDERED = {
    actionCode: "H30000",
    actionDate: "2026-11-09",
    text: "Considered under suspension of the rules.",
    type: "Floor",
  };
  const SRES734_AGREED = {
    actionCode: "17000",
    actionDate: "2026-05-14",
    text:
      "Passed/agreed to in Senate: Submitted in the Senate, considered, and agreed to without amendment and with a " +
      "preamble by Unanimous Consent.",
    type: "Floor",
  };
  const HR4593_PASSAGE = {
    actionCode: "8000",
    actionDate: "2026-01-07",
    text: "Passed/agreed to in House: On passage Passed by the Yeas and Nays: 226 - 197 (Roll no. 23).",
    type: "Floor",
  };
  const cited = <T extends { text: string }>(action: T, citation: string): T => ({
    ...action,
    text: `${action.text} ${citation}`,
  });

  describe("normalizeBillActionKey", () => {
    it.each([
      [
        "a citation added (H.R. 9614, 2026-11-11)",
        HR9614_CONSIDERED,
        cited(HR9614_CONSIDERED, "(consideration: CR H6104-6105)"),
      ],
      [
        "a citation changed",
        cited(HR9614_CONSIDERED, "(consideration: CR H6104-6105)"),
        cited(HR9614_CONSIDERED, "(text: CR H6104)"),
      ],
      ["a citation removed", cited(HR9614_PASSAGE, "(text: CR H6104)"), HR9614_PASSAGE],
      [
        "two citations in one parenthesis (S.Res. 734, 2026-11-09)",
        SRES734_AGREED,
        cited(SRES734_AGREED, "(consideration: CR S2313; text: CR S2310)"),
      ],
      ["a dated citation (H.R. 4593)", HR4593_PASSAGE, cited(HR4593_PASSAGE, "(text: CR 1/7/2026 H127)")],
    ])("is the same for %s", (_name, before, after) => {
      expect(normalizeBillActionKey(after)).toBe(normalizeBillActionKey(before));
    });

    it("still tells apart another day, code, type or wording, and keeps a roll call", () => {
      const key = normalizeBillActionKey(HR9614_PASSAGE);
      expect(normalizeBillActionKey({ ...HR9614_PASSAGE, actionDate: "2026-11-10" })).not.toBe(key);
      expect(normalizeBillActionKey({ ...HR9614_PASSAGE, actionCode: "H37300" })).not.toBe(key);
      expect(normalizeBillActionKey({ ...HR9614_PASSAGE, type: "President" })).not.toBe(key);
      expect(
        normalizeBillActionKey({
          ...HR9614_PASSAGE,
          text: HR9614_PASSAGE.text.replace("voice vote", "the Yeas and Nays"),
        }),
      ).not.toBe(key);
      expect(
        normalizeBillActionKey({ ...HR4593_PASSAGE, text: HR4593_PASSAGE.text.replace(" (Roll no. 23)", "") }),
      ).not.toBe(normalizeBillActionKey(HR4593_PASSAGE));
    });
  });

  describe("latestNewBillOutcomeAction", () => {
    it.each([
      ["H.R. 9614's passage line (2026-11-11 09:12Z)", HR9614_PASSAGE, "(text: CR H6104)"],
      ["S.Res. 734's agreed-to line (2026-11-09 02:10Z)", SRES734_AGREED, "(consideration: CR S2313; text: CR S2310)"],
      ["a passage line with a dated citation", HR4593_PASSAGE, "(text: CR 1/7/2026 H127)"],
    ])("finds no new outcome when %s gains a citation: no second passed", (_name, line, citation) => {
      expect(
        latestNewBillOutcomeAction([line, HR9614_CONSIDERED], [cited(line, citation), HR9614_CONSIDERED]),
      ).toBeNull();
      expect(latestNewBillOutcomeAction([cited(line, citation)], [line])).toBeNull();
    });

    it("finds no outcome when an old passage line gains a citation beside new actions (H.R. 6365)", () => {
      const housePassage = {
        actionCode: "8000",
        actionDate: "2026-03-03",
        text: "Passed/agreed to in House: On motion to suspend the rules and pass the bill, as amended Agreed to by voice vote.",
        type: "Floor",
      };
      const calendar = {
        actionDate: "2026-09-17",
        text: "Placed on Senate Legislative Calendar under General Orders. Calendar No. 664.",
        type: "Calendars",
      };
      expect(
        latestNewBillOutcomeAction([housePassage], [calendar, cited(housePassage, "(text: CR H2347)")]),
      ).toBeNull();
    });

    it("finds a new passage that comes with its citation, and keeps its text as congress.gov wrote it", () => {
      const passage = cited(HR9614_PASSAGE, "(text: CR H6104)");
      expect(
        latestNewBillOutcomeAction(
          [HR9614_CONSIDERED],
          [passage, cited(HR9614_CONSIDERED, "(consideration: CR H6104-6105)")],
        ),
      ).toEqual({
        kind: "passed",
        actionCode: "8000",
        actionDate: "2026-11-09",
        actionType: "Floor",
        text: passage.text,
      });
    });

    // REL-50's failures of the bill itself as stored, with no Failed status after them to keep a second failed back
    // when the bill passed on a later vote: this is the only guard. Citations as congress.gov wrote them on H.R. 9614,
    // on H.R. 5371's failed Senate vote of 2025-09-19, and on H.R. 4593.
    const HR2262_FAILURE = {
      actionCode: "9000",
      actionDate: "2026-01-13",
      text: "Failed of passage/not agreed to in House On passage Failed by the Yeas and Nays: 209 - 215 (Roll no. 19).",
      type: "Floor",
    };
    const SJRES71_FAILURE = {
      actionCode: "18000",
      actionDate: "2025-10-08",
      text: "Failed of passage/not agreed to in Senate: Failed of passage in Senate by Yea-Nay Vote. 47 - 51. Record Vote Number: 554.",
      type: "Floor",
    };
    const HR131_VETO_FAILURE = {
      actionCode: "33000",
      actionDate: "2026-01-08",
      text:
        "Failed of passage in House over veto On passage, the objections of the President to the contrary " +
        "notwithstanding Failed by the Yeas and Nays: (2/3 required): 248 - 177, 1 Present (Roll no. 9).",
      type: "Veto",
    };

    it.each([
      ["H.R. 2262's failure in the House (9000)", HR2262_FAILURE, "(consideration: CR H6104-6105)"],
      ["S.J.Res. 71's failure in the Senate (18000)", SJRES71_FAILURE, "(consideration: CR S6785)"],
      ["H.R. 131's failure over the veto (33000)", HR131_VETO_FAILURE, "(text: CR 1/7/2026 H127)"],
    ])("finds no new outcome when %s gains, changes or loses a citation: no second failed", (_name, line, citation) => {
      expect(billOutcomeKindForAction(line)).toBe("failed");
      expect(
        latestNewBillOutcomeAction([line, HR9614_CONSIDERED], [cited(line, citation), HR9614_CONSIDERED]),
      ).toBeNull();
      expect(latestNewBillOutcomeAction([cited(line, citation)], [cited(line, "(text: CR H6104)")])).toBeNull();
      expect(latestNewBillOutcomeAction([cited(line, citation)], [line])).toBeNull();
    });

    it("finds a new failure that comes with its citation, and keeps its text as congress.gov wrote it", () => {
      const failure = cited(HR2262_FAILURE, "(consideration: CR H6104-6105)");
      expect(latestNewBillOutcomeAction([HR9614_CONSIDERED], [failure, HR9614_CONSIDERED])).toEqual({
        kind: "failed",
        actionCode: "9000",
        actionDate: "2026-01-13",
        actionType: "Floor",
        text: failure.text,
      });
    });
  });

  describe("newBillActions", () => {
    // H.R. 8800 on 2026-07-22, as stored: the House took it up as unfinished business twice that day, and congress.gov
    // lists the newest line first.
    const UNFINISHED_MORNING = {
      actionCode: "H30000",
      actionDate: "2026-07-22",
      actionTime: "11:20:43",
      text: "Considered as unfinished business. (consideration: CR H5029-5127)",
      type: "Floor",
    };
    const UNFINISHED_AFTERNOON = {
      ...UNFINISHED_MORNING,
      actionTime: "15:31:07",
      text: "Considered as unfinished business. (consideration: CR H5153-5157)",
    };
    const COMMITTEE_RISES = {
      actionCode: "H32700",
      actionDate: "2026-07-22",
      actionTime: "12:47:27",
      text: "Committee of the Whole House on the state of the Union rises leaving H.R. 8800 as unfinished business.",
      type: "Floor",
    };

    it("finds none when lines only gained, changed or lost citations", () => {
      expect(
        newBillActions(
          [HR9614_PASSAGE, HR9614_CONSIDERED, SRES734_AGREED],
          [
            cited(HR9614_PASSAGE, "(text: CR H6104)"),
            cited(HR9614_CONSIDERED, "(consideration: CR H6104-6105)"),
            cited(SRES734_AGREED, "(consideration: CR S2313; text: CR S2310)"),
          ],
        ).size,
      ).toBe(0);
      expect(
        newBillActions(
          [cited(HR9614_CONSIDERED, "(consideration: CR H6104-6105)")],
          [cited(HR9614_CONSIDERED, "(text: CR H6104)")],
        ).size,
      ).toBe(0);
      expect(newBillActions([cited(HR4593_PASSAGE, "(text: CR 1/7/2026 H127)")], [HR4593_PASSAGE]).size).toBe(0);
    });

    it("finds a step repeated that day that comes in a later version with a citation of its own (H.R. 8800)", () => {
      expect([
        ...newBillActions(
          [COMMITTEE_RISES, UNFINISHED_MORNING],
          [UNFINISHED_AFTERNOON, COMMITTEE_RISES, UNFINISHED_MORNING],
        ),
      ]).toEqual([UNFINISHED_AFTERNOON]);
    });

    it("finds the newer of two such lines when the older gains its citation in the same version", () => {
      const morningUncited = { ...UNFINISHED_MORNING, text: "Considered as unfinished business." };
      expect([
        ...newBillActions(
          [COMMITTEE_RISES, morningUncited],
          [UNFINISHED_AFTERNOON, COMMITTEE_RISES, UNFINISHED_MORNING],
        ),
      ]).toEqual([UNFINISHED_AFTERNOON]);
    });

    it("finds a new line and a reworded one, with or without a citation", () => {
      const reworded = { ...HR9614_PASSAGE, text: HR9614_PASSAGE.text.replace("voice vote", "the Yeas and Nays") };
      const passageCited = cited(HR9614_PASSAGE, "(text: CR H6104)");
      expect([...newBillActions([HR9614_CONSIDERED], [passageCited, HR9614_CONSIDERED])]).toEqual([passageCited]);
      expect([...newBillActions([HR9614_PASSAGE], [reworded])]).toEqual([reworded]);
      expect([...newBillActions([HR9614_PASSAGE], [cited(reworded, "(text: CR H6104)")])]).toEqual([
        cited(reworded, "(text: CR H6104)"),
      ]);
    });

    it("finds no line the previous version had as written, as before: H.R. 7333's referral, one line per committee", () => {
      const referral = {
        actionCode: "H11100",
        actionDate: "2026-02-03",
        text:
          "Referred to the Committee on Education and Workforce, and in addition to the Committee on Energy and " +
          "Commerce, for a period to be subsequently determined by the Speaker, in each case for consideration of " +
          "such provisions as fall within the jurisdiction of the committee concerned.",
        type: "IntroReferral",
      };
      expect(newBillActions([referral], [referral, { ...referral }]).size).toBe(0);
    });
  });
});
