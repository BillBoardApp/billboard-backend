import type { AttributeValue } from "@aws-sdk/client-dynamodb";

import {
  DEFAULT_RATE,
  configFromEnv,
  defaultPlanFile,
  defaultUndoFile,
  parseArgs,
  parsePlanFile,
  runRelabel,
  whatItDoes,
  type CliOptions,
  type PlanLine,
} from "../../scripts/relabelCeremonialRows";
import { conditionalCheckFailed, evaluateCondition, type ConditionInput } from "./fixtures/dynamoCondition";
import { CURATED_CEREMONIAL_OVERRIDES } from "./fixtures/curatedCeremonialOverrides";

/*
 * relabel:ceremonial-rows (S6, 2026-10-29): plans exactly the ceremonial resolutions' rows that still
 * carry topics (or life areas), and empties those lists in place: no row moves, and nothing but the row is written.
 */

type Item = Record<string, AttributeValue>;
type Doc = Record<string, unknown>;

/** What the fakes read from an AWS SDK command: its class's name and its input. */
interface FakeCommand<Input> {
  constructor: { name: string };
  input: Input;
}
interface FakeDynamoInput extends ConditionInput {
  TableName?: string;
  ConsistentRead?: boolean;
  ExpressionAttributeValues?: Record<string, AttributeValue>;
  ExclusiveStartKey?: { page: { N: string } };
  Key?: Item;
  UpdateExpression?: string;
}
type FakeSender<Input> = jest.Mock<Promise<unknown>, [FakeCommand<Input>]>;

const config = configFromEnv({});
const NOW = new Date("2026-10-29T18:00:00.000Z");

const list = (values: string[]): AttributeValue => ({ L: values.map((value) => ({ S: value })) });

/** A BILL row as CreateBillsManifest writes it (or, with `legacy`, as a release before 2026-10-28 did). */
const row = (
  guid: string,
  updatedAt: string,
  {
    billType = guid.replace(/^BILLS-\d+([a-z]+)\d+$/, "$1"),
    title = `Headline of ${guid}`,
    subCategories = [] as string[],
    lifeAreas = [] as string[],
    legacy = false,
  } = {},
): Item => ({
  pk: { S: "BILL" },
  sk: { S: `${updatedAt}#${guid}` },
  guid: { S: guid },
  billType: { S: billType },
  congress: { S: "119" },
  billNumber: { S: guid.replace(/\D+/g, "").slice(3) },
  updatedAt: { S: updatedAt },
  title: { S: title },
  subCategories: list(subCategories),
  lifeAreas: list(lifeAreas),
  sponsors: list(["B001318"]),
  cosponsors: list([]),
  voteCount: { N: "7" },
  billStatus: { S: "New" },
  ...(legacy
    ? {}
    : {
        contentHash: { S: `v1:${guid.length.toString(16).padStart(16, "0")}:0000000000000000` },
        dateBasis: { S: "d1|New|2026-10-16||" },
        documentStoredAt: { S: updatedAt },
      }),
});

/** A processed bill with the summarizer's labels. */
const doc = (guid: string, billType: string, officialTitle: string | undefined, extra: Doc = {}): Doc => ({
  kind: "processed",
  storedAt: "2026-10-27T08:16:21.099Z",
  identifier: { congress: "119", billType, billNumber: guid.replace(/\D+/g, "").slice(3) },
  guid,
  title: `Headline of ${guid}`,
  ...(officialTitle ? { officialTitle } : {}),
  subCategories: ["Education"],
  lifeAreas: ["Medical Costs"],
  ...extra,
});

const fakeTable = (rows: Item[]) => {
  const items = new Map<string, Item>(rows.map((item) => [item.sk.S!, structuredClone(item)]));
  const commands: Array<{ name: string; input: FakeDynamoInput }> = [];
  /** Runs before an UpdateItem is evaluated: a concurrent writer between the script's read and its write. */
  let beforeUpdate: (() => void) | undefined;
  const send: FakeSender<FakeDynamoInput> = jest.fn(async (command: FakeCommand<FakeDynamoInput>) => {
    const name: string = command.constructor.name;
    const input = command.input;
    commands.push({ name, input });
    expect(input.TableName).toBe("BillsManifest");
    if (name === "QueryCommand") {
      expect(input.ConsistentRead).toBe(true);
      const all = [...items.values()]
        .filter((item) => item.pk.S === input.ExpressionAttributeValues![":pk"].S)
        .sort((a, b) => (a.sk.S! < b.sk.S! ? -1 : 1));
      // Pages of three, as DynamoDB pages a large partition.
      const start = input.ExclusiveStartKey ? Number(input.ExclusiveStartKey.page.N) : 0;
      return {
        Items: all.slice(start, start + 3).map((item) => structuredClone(item)),
        ...(start + 3 < all.length ? { LastEvaluatedKey: { page: { N: String(start + 3) } } } : {}),
      };
    }
    if (name === "GetItemCommand") {
      expect(input.ConsistentRead).toBe(true);
      const item = items.get(input.Key!.sk.S!);
      return item ? { Item: structuredClone(item) } : {};
    }
    if (name === "UpdateItemCommand") {
      beforeUpdate?.();
      beforeUpdate = undefined;
      const current = items.get(input.Key!.sk.S!);
      if (!current || !evaluateCondition(current, input)) throw conditionalCheckFailed();
      const next = structuredClone(current);
      for (const clause of String(input.UpdateExpression).replace(/^SET /, "").split(/,\s*/)) {
        const match = clause.match(/^(#\w+) = (:\w+)$/);
        if (!match) throw new Error(`Unsupported update clause ${clause}`);
        next[input.ExpressionAttributeNames![match[1]]] = input.ExpressionAttributeValues![match[2]];
      }
      items.set(input.Key!.sk.S!, next);
      return {};
    }
    throw new Error(`Unexpected DynamoDB command ${name}`);
  });
  return {
    db: { send },
    items,
    commands,
    names: () => commands.map((command) => command.name),
    onNextUpdate: (fn: () => void) => {
      beforeUpdate = fn;
    },
  };
};

const fakeS3 = (docs: Record<string, Doc>) => {
  const keys: string[] = [];
  const send = jest.fn(async (command: FakeCommand<{ Bucket?: string; Key?: string }>) => {
    const name: string = command.constructor.name;
    if (name !== "GetObjectCommand") throw new Error(`Unexpected S3 command ${name}`);
    expect(command.input.Bucket).toBe("billboard-bill-store-bucket");
    keys.push(command.input.Key!);
    const guid = String(command.input.Key)
      .replace(/^processed-bills\//, "")
      .replace(/\.json$/, "");
    const body = docs[guid];
    if (!body) throw Object.assign(new Error("The specified key does not exist."), { name: "NoSuchKey" });
    return { Body: { transformToString: async () => JSON.stringify(body) } };
  });
  return { s3: { send }, keys };
};

const fakeSqs = (depths: Record<string, [number, number, number]> = {}) => {
  const names: string[] = [];
  const send = jest.fn(async (command: FakeCommand<{ QueueName?: string; QueueUrl?: string }>) => {
    const name: string = command.constructor.name;
    names.push(name);
    if (name === "GetQueueUrlCommand") return { QueueUrl: `https://sqs/${command.input.QueueName}` };
    if (name === "GetQueueAttributesCommand") {
      const [visible, notVisible, delayed] = depths[String(command.input.QueueUrl).split("/").pop()!] ?? [0, 0, 0];
      return {
        Attributes: {
          ApproximateNumberOfMessages: String(visible),
          ApproximateNumberOfMessagesNotVisible: String(notVisible),
          ApproximateNumberOfMessagesDelayed: String(delayed),
        },
      };
    }
    throw new Error(`Unexpected SQS command ${name}`);
  });
  return { sqs: { send }, names };
};

const files = () => {
  const store = new Map<string, string>();
  return {
    store,
    createFile: (path: string, text: string) => {
      if (store.has(path)) throw new Error(`EEXIST: ${path}`);
      store.set(path, text);
    },
    appendFile: (path: string, text: string) => store.set(path, (store.get(path) ?? "") + text),
    readFile: (path: string) => {
      const text = store.get(path);
      if (text === undefined) throw new Error(`ENOENT: ${path}`);
      return text;
    },
  };
};

const options = (argv: string[]): CliOptions => parseArgs(argv);

// ─── The world: the curated rows of 2026-10-29 and the resolutions that must keep their labels ──────────────────────

const DATED = "2026-10-26T14:39:02.049Z";
const CAREERS = "BILLS-119hres826"; // ceremonial by its official title, topics only
const HEART = "BILLS-119hres1043"; // ceremonial by its headline (no official title), typed by its slug, both lists
const HONOR = "BILLS-119sres617"; // ceremonial, life areas only (the 2026-10-29 relabel missed slug-typed rows)
const CLEAN = "BILLS-119hres1187"; // ceremonial, already relabelled: no topics, no life areas
const CONDEMN = "BILLS-119hres900"; // condemns
const CENSURE = "BILLS-119hres901"; // censures
const IMPEACH = "BILLS-119hres902"; // impeaches
const URGE = "BILLS-119hres903"; // recognizes, then calls on someone to act
const RULE = "BILLS-119hres904"; // a rule for a bill's consideration
const POST_OFFICE = "BILLS-119hr905"; // a bill: never ceremonial
const LEGACY = "BILLS-119sres95"; // ceremonial, a row an older release wrote (no hash, basis or documentStoredAt)
const ENCOURAGE = "BILLS-119hres1572"; // a card seen in the app: "Encouraging the recognition of ...", topics only
const ASKS = "BILLS-119hres930"; // a headline that decides and also asks for something ("... and Free ...")

/**
 * The world; with `cases2029`, also the two rows the review of 2026-10-29 added: a card seen in the app (an official title
 * the first rule missed) and a headline that decides and also asks for something.
 */
const world = ({ cases2029 = false } = {}) => {
  const rows = [
    row(CAREERS, DATED, { subCategories: ["Education", "Labor and Employment"] }),
    row(HEART, "2026-03-19T18:41:25.739Z", {
      billType: "house-resolution",
      title: "Recognize American Heart Month",
      subCategories: ["Healthcare"],
      lifeAreas: ["Health Insurance", "Medical Costs"],
    }),
    row(HONOR, "2026-03-20T10:00:00.000Z", { billType: "senate-resolution", lifeAreas: ["Student Loans"] }),
    row(CLEAN, "2026-04-18T02:53:41.823Z"),
    row(CONDEMN, DATED, { subCategories: ["Diplomacy"] }),
    row(CENSURE, DATED, { subCategories: ["Transparency and Accountability"] }),
    row(IMPEACH, DATED, { subCategories: ["Constitutional and Legal Issues"], lifeAreas: ["Taxes"] }),
    row(URGE, DATED, { subCategories: ["Labor and Employment"] }),
    row(RULE, DATED, { subCategories: ["Energy"] }),
    row(POST_OFFICE, DATED, { subCategories: ["Local Government"] }),
    row(LEGACY, "2026-03-19T16:39:17.097Z", { subCategories: ["Healthcare"], legacy: true }),
  ];
  const docs: Record<string, Doc> = {
    [CAREERS]: doc(
      CAREERS,
      "hres",
      "Expressing support for the designation of the week of October 20 to October 24, 2025, as Careers in Energy Week.",
    ),
    [HEART]: doc(HEART, "house-resolution", undefined, {
      title: "Recognize American Heart Month",
      billBreakdown: { what: "The resolution recognizes February as American Heart Month." },
      soWhat: "No law changes.",
    }),
    [HONOR]: doc(HONOR, "senate-resolution", "Honoring the life and legacy of a former Senator."),
    [CLEAN]: doc(CLEAN, "hres", "Expressing support for the designation of Community Health Workers Week."),
    [CONDEMN]: doc(CONDEMN, "hres", "Condemning the attack on the embassy and recognizing the courage of its staff."),
    [CENSURE]: doc(CENSURE, "hres", "Censuring Representative Doe."),
    [IMPEACH]: doc(IMPEACH, "hres", "Impeaching Judge Roe for high crimes and misdemeanors."),
    [URGE]: doc(URGE, "hres", "Recognizing the anniversary of the strike and calling on the Secretary to act."),
    [RULE]: doc(RULE, "hres", "Providing for consideration of the bill (H.R. 77) to amend the Clean Air Act."),
    [POST_OFFICE]: doc(POST_OFFICE, "hr", "To designate the facility of the United States Postal Service."),
    [LEGACY]: doc(LEGACY, "sres", "Designating the week of May 11 as National Fentanyl Awareness Week."),
  };
  if (cases2029) {
    rows.push(
      row(ENCOURAGE, "2026-10-27T08:16:21.099Z", {
        title: "Recognize National LGBTQ+ Servicemembers and Veterans Day",
        subCategories: ["Civil Rights and Liberties", "Military and Defense"],
      }),
      row(ASKS, DATED, {
        title: "Celebrate Jimmy Lai and Free Hong Kong Activists",
        subCategories: ["Freedom of Speech and Press", "Diplomacy"],
      }),
    );
    Object.assign(docs, {
      [ENCOURAGE]: doc(
        ENCOURAGE,
        "hres",
        "Encouraging the recognition of a National LGBTQ+ Servicemembers and Veterans Day.",
      ),
      [ASKS]: doc(ASKS, "hres", undefined, {
        title: "Celebrate Jimmy Lai and Free Hong Kong Activists",
        soWhat: "They're asking China to let him go.",
      }),
    });
  }
  return { rows, docs };
};

const run = async (
  argv: string[],
  {
    table,
    s3 = fakeS3({}),
    sqs = fakeSqs(),
    fs = files(),
    interrupted = () => false,
  }: {
    table: ReturnType<typeof fakeTable>;
    s3?: ReturnType<typeof fakeS3>;
    sqs?: ReturnType<typeof fakeSqs>;
    fs?: ReturnType<typeof files>;
    interrupted?: () => boolean;
  },
) => {
  const log = jest.fn();
  const logError = jest.fn();
  const sleep = jest.fn(async (_ms: number) => undefined);
  const result = await runRelabel({
    db: table.db,
    s3: s3.s3,
    sqs: sqs.sqs,
    config,
    options: options(argv),
    log,
    logError,
    now: () => NOW,
    sleep,
    ...fs,
    interrupted,
  });
  return { result, lines: log.mock.calls.map((call) => String(call[0])), logError, sleep, fs };
};

/** The dry run of the world, with its plan in `fs` as plan.jsonl. */
const dryRun = async ({ cases2029 = false } = {}) => {
  const { rows, docs } = world({ cases2029 });
  const table = fakeTable(rows);
  const s3 = fakeS3(docs);
  const fs = files();
  const out = await run(["--plan-file", "plan.jsonl"], { table, s3, fs });
  return { ...out, table, s3, fs, rows, docs };
};

describe("whatItDoes", () => {
  it("says what the bill does for the review of a row its headline decided: billBreakdown.what, else soWhat", () => {
    expect(whatItDoes({ billBreakdown: { what: " Names a week.\n" }, soWhat: "No law changes." })).toBe(
      "Names a week.",
    );
    expect(whatItDoes({ billBreakdown: { what: "" }, soWhat: "They're asking China to let him go." })).toBe(
      "They're asking China to let him go.",
    );
    expect(whatItDoes({ content: { rawSnapshot: { soWhat: "Through the wrapper." } } })).toBe("Through the wrapper.");
    expect(whatItDoes({ title: "Nothing else" })).toBeNull();
    expect(whatItDoes(null)).toBeNull();
    const long = whatItDoes({ soWhat: "x".repeat(400) })!;
    expect(long).toHaveLength(240);
    expect(long.endsWith("...")).toBe(true);
  });
});

describe("parseArgs", () => {
  it("is a dry run by default, and --apply needs a reviewed plan", () => {
    expect(parseArgs([])).toMatchObject({ apply: false, rate: DEFAULT_RATE, planFile: null, undo: null });
    expect(() => parseArgs(["--apply"])).toThrow("--apply needs --plan-file");
    expect(parseArgs(["--apply", "--plan-file", "p.jsonl"])).toMatchObject({ apply: true, planFile: "p.jsonl" });
  });

  it("refuses what it does not know, and takes a guid without its text-version suffix", () => {
    expect(() => parseArgs(["--apply", "--plan-file", "p", "--force"])).toThrow("Unknown argument: --force");
    expect(parseArgs(["--guid", "BILLS-119hres826ih"]).guids).toEqual(["BILLS-119hres826"]);
    expect(() => parseArgs(["--guid", "H.Res. 826"])).toThrow("--guid needs a bill guid");
    expect(() => parseArgs(["--rate", "50"])).toThrow("--rate needs a whole number from 1 to 10");
    expect(() => parseArgs(["--undo", "u.jsonl", "--plan-file", "p"])).toThrow("--undo takes neither");
    expect(() => parseArgs(["--undo-file", "u.jsonl"])).toThrow("a dry run writes none");
  });

  it("names its files by the UTC time", () => {
    expect(defaultPlanFile(NOW)).toBe("relabel-ceremonial-rows-plan-20261029T180000Z.jsonl");
    expect(defaultUndoFile(NOW)).toBe("relabel-ceremonial-rows-undo-20261029T180000Z.jsonl");
  });
});

describe("the dry run", () => {
  it("plans exactly the ceremonial resolutions' rows that carry topics or life areas, and nothing else", async () => {
    const { result, fs } = await dryRun({ cases2029: true });

    expect(result.exitCode).toBe(0);
    const plan = parsePlanFile(fs.store.get("plan.jsonl")!);
    expect(plan.map((line) => [line.guid, line.before])).toEqual([
      [HEART, { subCategories: ["Healthcare"], lifeAreas: ["Health Insurance", "Medical Costs"] }],
      [ENCOURAGE, { subCategories: ["Civil Rights and Liberties", "Military and Defense"] }],
      [CAREERS, { subCategories: ["Education", "Labor and Employment"] }],
      [HONOR, { lifeAreas: ["Student Loans"] }],
      [LEGACY, { subCategories: ["Healthcare"] }],
    ]);
    expect(result.summary).toEqual({
      rows: 13,
      resolutions: 12,
      labelled: 11,
      planned: 5,
      byHeadline: 1,
      withTopics: 4,
      withLifeAreas: 2,
      notCeremonial: 6,
      unreadable: 0,
    });
  });

  it("keeps each line's key and the row's version as read, so the apply writes that row at that key only", async () => {
    const { fs, rows } = await dryRun();
    const plan = parsePlanFile(fs.store.get("plan.jsonl")!);
    const careers = rows.find((item) => item.guid.S === CAREERS)!;

    expect(plan.find((line) => line.guid === CAREERS)).toEqual({
      guid: CAREERS,
      sk: `${DATED}#${CAREERS}`,
      billType: "hres",
      title: `Headline of ${CAREERS}`,
      officialTitle:
        "Expressing support for the designation of the week of October 20 to October 24, 2025, as Careers in Energy Week.",
      before: { subCategories: ["Education", "Labor and Employment"] },
      version: {
        updatedAt: DATED,
        contentHash: careers.contentHash.S,
        dateBasis: "d1|New|2026-10-16||",
        documentStoredAt: DATED,
      },
    });
    expect(plan.find((line) => line.guid === LEGACY)!.version).toEqual({
      updatedAt: "2026-03-19T16:39:17.097Z",
      contentHash: null,
      dateBasis: null,
      documentStoredAt: null,
    });
  });

  it("prints each planned row's change and the title that decided, and lists the resolutions it leaves alone", async () => {
    const { lines } = await dryRun({ cases2029: true });

    expect(lines).toContain(
      `  planned ${CAREERS} (official title) "Headline of ${CAREERS}": topics [Education, Labor and Employment] -> []`,
    );
    expect(lines).toContain(
      `  planned ${ENCOURAGE} (official title) "Recognize National LGBTQ+ Servicemembers and Veterans Day": ` +
        "topics [Civil Rights and Liberties, Military and Defense] -> []",
    );
    // A row the headline decided says so, and what the bill does, for the review.
    const heart = lines.indexOf(
      `  planned ${HEART} (headline) "Recognize American Heart Month": topics [Healthcare] -> [], ` +
        "life areas [Health Insurance, Medical Costs] -> []",
    );
    expect(lines.slice(heart + 1, heart + 3)).toEqual([
      "    official title: (none; the headline decided)",
      "    what it does: The resolution recognizes February as American Heart Month.",
    ]);
    expect(lines.filter((line) => line.startsWith("    what it does: "))).toHaveLength(1);
    expect(lines).toContain(
      `  not ceremonial ${ASKS} (headline): Celebrate Jimmy Lai and Free Hong Kong Activists ` +
        "(keeps topics [Freedom of Speech and Press, Diplomacy])",
    );
    expect(lines).toContain(
      "Review the 1 planned rows marked (headline) with what each does; take any that asks for something out of the " +
        "plan file before --apply (RUNBOOK 4.12).",
    );
    expect(lines).toContain(
      `  not ceremonial ${IMPEACH} (official title): Impeaching Judge Roe for high crimes and misdemeanors. ` +
        "(keeps topics [Constitutional and Legal Issues], life areas [Taxes])",
    );
    for (const guid of [CONDEMN, CENSURE, URGE, RULE]) {
      expect(lines.some((line) => line.startsWith(`  not ceremonial ${guid} `))).toBe(true);
    }
    expect(lines.at(-2)).toBe(
      "Ceremonial relabel plan: rows=13 resolutions=12 labelled=11 planned=5 byHeadline=1 withTopics=4 " +
        "withLifeAreas=2 notCeremonial=6 unreadable=0",
    );
  });

  it("follows the curated overrides of 2026-10-29, says so, and leaves them out of the headline review", async () => {
    // The rows as they are: their topics, no life areas (S6 took them), and documents with no official title. A row
    // without topics (hres955, hres440, hres1528 and four Equal Pay Day rows) carries no list here, so no line.
    const rows = CURATED_CEREMONIAL_OVERRIDES.map(({ guid, headline, subCategories }) =>
      row(guid, DATED, { title: headline, subCategories }),
    );
    const docs = Object.fromEntries(
      CURATED_CEREMONIAL_OVERRIDES.map(({ guid, billType, headline, subCategories, lifeAreas }) => [
        guid,
        doc(guid, billType, undefined, { title: headline, subCategories, lifeAreas, soWhat: "No law changes." }),
      ]),
    );
    const fs = files();

    const { result, lines } = await run(["--plan-file", "plan.jsonl"], {
      table: fakeTable(rows),
      s3: fakeS3(docs),
      fs,
    });

    expect(result.exitCode).toBe(0);
    expect(parsePlanFile(fs.store.get("plan.jsonl")!).map((line) => [line.guid, line.before])).toEqual([
      // Second round: the Equal Pay Day resolutions with topics, and the two that fight or stop hate.
      ["BILLS-119hconres42", { subCategories: ["Labor and Employment", "Social Justice"] }],
      ["BILLS-119hconres81", { subCategories: ["Labor and Employment", "Social Justice"] }],
      ["BILLS-119hres48", { subCategories: ["Social Justice"] }],
      ["BILLS-119hres819", { subCategories: ["Social Justice", "Identity Politics"] }],
      ["BILLS-119hres862", { subCategories: ["Social Justice"] }],
      ["BILLS-119sconres36", { subCategories: ["Labor and Employment", "Social Justice"] }],
      ["BILLS-119sres738", { subCategories: ["Social Justice", "Identity Politics"] }],
    ]);
    const hres48 = lines.indexOf(
      '  planned BILLS-119hres48 (curated override) "Honor MLK and celebrate diversity": topics [Social Justice] -> []',
    );
    expect(lines.slice(hres48 + 1, hres48 + 2)).toEqual(["    official title: (none)"]);
    expect(lines).toContain(
      '  planned BILLS-119hres862 (curated override) "Honor Buffalo Soldiers with commemorative stamp": ' +
        "topics [Social Justice] -> []",
    );
    expect(lines).toContain(
      '  planned BILLS-119sres738 (curated override) "Celebrate Jewish American Heritage Month and fight hate": ' +
        "topics [Social Justice, Identity Politics] -> []",
    );
    expect(lines).toContain(
      "  not ceremonial BILLS-119hres1365 (curated override): Recognize ARFID as serious eating disorder " +
        "(keeps topics [Healthcare])",
    );
    expect(lines).toContain(
      "  not ceremonial BILLS-119hconres107 (curated override): Recognizing gun violence as a serious problem on " +
        "America's 250th birthday (keeps topics [Social Justice, Healthcare])",
    );
    expect(lines).toContain(
      "  not ceremonial BILLS-119hres1304 (curated override): Honoring DC military members denied voting rights " +
        "(keeps topics [Elections and Voting])",
    );
    expect(lines).toContain(
      "  not ceremonial BILLS-119hconres112 (curated override): Recognizes need to improve access to federal facilities " +
        "(keeps topics [Civil Rights and Liberties, Local vs. Federal Power])",
    );
    // The review read them: no "what it does", and no review.
    expect(lines.filter((line) => line.startsWith("    what it does: "))).toEqual([]);
    expect(lines.some((line) => line.startsWith("Review the "))).toBe(false);
    expect(result.summary).toMatchObject({ planned: 7, byHeadline: 0, notCeremonial: 4 });
    expect(lines.filter((line) => line.includes("(curated override)"))).toHaveLength(11);
  });

  it("plans a headline that designates a day, week or month, with its guard, and names the held ones", async () => {
    // Answer 4 (2026-10-29): BILLS-119hres449 and hres613 are tagged by the clause; hres551 is kept by its
    // guard ("Stop" is its day's name); hconres53 (access to contraception) and hres756 (it encourages Congress to pass
    // voting rights bills) are held for review, and so is sres854, whose official title would tag it.
    const cases = [
      ["BILLS-119hres449", "Make May ALS Awareness Month", ["Healthcare"], [] as string[], undefined],
      ["BILLS-119hres613", 'Make July "Disability Pride Month"', ["Social Justice"], [], undefined],
      ["BILLS-119hres551", "Create National Stop SuiSilence Day", [], ["Health Insurance", "Medical Costs"], undefined],
      [
        "BILLS-119hconres53",
        "Support World Contraception Day and birth control access",
        [],
        ["Medical Costs"],
        undefined,
      ],
      ["BILLS-119hres756", "Make September 2025 National Voting Rights Month", ["Elections and Voting"], [], undefined],
      [
        "BILLS-119sres854",
        "Designates September 2026 as National Voting Rights Month",
        ["Elections and Voting", "Education"],
        [],
        "Designating September 2026 as National Voting Rights Month.",
      ],
    ] as const;
    const fs = files();
    const { result, lines } = await run(["--plan-file", "plan.jsonl"], {
      table: fakeTable(
        cases.map(([guid, title, subCategories, lifeAreas]) =>
          row(guid, DATED, { title, subCategories: [...subCategories], lifeAreas: [...lifeAreas] }),
        ),
      ),
      s3: fakeS3(
        Object.fromEntries(
          cases.map(([guid, title, subCategories, lifeAreas, officialTitle]) => [
            guid,
            doc(guid, guid.replace(/^BILLS-\d+([a-z]+)\d+$/, "$1"), officialTitle, {
              title,
              subCategories: [...subCategories],
              lifeAreas: [...lifeAreas],
              billBreakdown: { what: `What ${guid} does.` },
            }),
          ]),
        ),
      ),
      fs,
    });

    expect(result.exitCode).toBe(0);
    expect(parsePlanFile(fs.store.get("plan.jsonl")!).map((line) => line.guid)).toEqual([
      "BILLS-119hres449",
      "BILLS-119hres613",
    ]);
    expect(lines).toContain(
      '  planned BILLS-119hres449 (headline) "Make May ALS Awareness Month": topics [Healthcare] -> []',
    );
    expect(lines).toContain("    what it does: What BILLS-119hres449 does.");
    expect(lines).toContain(
      "  not ceremonial BILLS-119hres551 (headline): Create National Stop SuiSilence Day " +
        "(keeps life areas [Health Insurance, Medical Costs])",
    );
    expect(lines).toContain(
      "  not ceremonial BILLS-119hconres53 (held for review): Support World Contraception Day and birth " +
        "control access (keeps life areas [Medical Costs])",
    );
    expect(lines).toContain(
      "  not ceremonial BILLS-119hres756 (held for review): Make September 2025 National Voting Rights Month " +
        "(keeps topics [Elections and Voting])",
    );
    expect(lines).toContain(
      "  not ceremonial BILLS-119sres854 (held for review): Designating September 2026 as National Voting Rights " +
        "Month. (keeps topics [Elections and Voting, Education])",
    );
    expect(result.summary).toMatchObject({ planned: 2, byHeadline: 2, notCeremonial: 4 });

    // A plan line for a held row (one made before the hold) is refused, and named as held.
    const held: PlanLine = {
      guid: "BILLS-119hconres53",
      sk: `${DATED}#BILLS-119hconres53`,
      billType: "hconres",
      title: "Support World Contraception Day and birth control access",
      officialTitle: null,
      before: { lifeAreas: ["Medical Costs"] },
      version: { updatedAt: DATED, contentHash: null, dateBasis: null, documentStoredAt: null },
    };
    // Every plan of 2026-10-29 lists sres854, which its official title tags, and the second round's lists hres756.
    const heldByTitle: PlanLine = {
      guid: "BILLS-119sres854",
      sk: `${DATED}#BILLS-119sres854`,
      billType: "sres",
      title: "Designates September 2026 as National Voting Rights Month",
      officialTitle: "Designating September 2026 as National Voting Rights Month.",
      before: { subCategories: ["Elections and Voting", "Education"] },
      version: { updatedAt: DATED, contentHash: null, dateBasis: null, documentStoredAt: null },
    };
    fs.store.set("held-plan.jsonl", `${JSON.stringify(held)}\n${JSON.stringify(heldByTitle)}\n`);
    const refused = await run(["--apply", "--plan-file", "held-plan.jsonl"], { table: fakeTable([]), fs });
    expect(refused.result.exitCode).toBe(2);
    expect(refused.lines).toContain(
      "  not ceremonial now: BILLS-119hconres53 (held for review) life areas [Medical Costs] -> []",
    );
    expect(refused.lines).toContain(
      "  not ceremonial now: BILLS-119sres854 (held for review) topics [Elections and Voting, Education] -> []",
    );
  });

  it("names a bill that follows a curated override as its companion's, not as an override of its own", async () => {
    // S.Con.Res. 34 once RUNBOOK 4.12 step 5b gives its row its document's life areas back.
    const sconres34 = "BILLS-119sconres34";
    const headline = "Recognizing gun violence as a public health problem on America's 250th birthday";
    const { result, lines } = await run(["--plan-file", "plan.jsonl"], {
      table: fakeTable([row(sconres34, DATED, { title: headline, lifeAreas: ["Health Insurance", "Medical Costs"] })]),
      s3: fakeS3({ [sconres34]: doc(sconres34, "sconres", undefined, { title: headline }) }),
    });

    expect(result.summary).toMatchObject({ planned: 0, notCeremonial: 1 });
    expect(lines).toContain(
      "  not ceremonial BILLS-119sconres34 (curated override, companion of BILLS-119hconres107): " +
        `${headline} (keeps life areas [Health Insurance, Medical Costs])`,
    );
    // RUNBOOK 4.12's grep for the curated overrides does not count it.
    expect(lines.filter((line) => line.includes("(curated override)"))).toEqual([]);
  });

  it("only reads: a consistent Query, and the processed bills of labelled resolutions", async () => {
    const { table, s3 } = await dryRun({ cases2029: true });

    expect(new Set(table.names())).toEqual(new Set(["QueryCommand"]));
    // Neither the bill (POST_OFFICE) nor the clean ceremonial row (CLEAN) is read.
    expect(s3.keys.sort()).toEqual(
      [HEART, CAREERS, CONDEMN, CENSURE, IMPEACH, URGE, RULE, LEGACY, HONOR, ENCOURAGE, ASKS]
        .map((guid) => `processed-bills/${guid}.json`)
        .sort(),
    );
  });

  it("reports a row whose processed bill cannot be read, and exits 1", async () => {
    const { rows, docs } = world();
    delete docs[CAREERS];
    const { result, lines } = await run(["--plan-file", "plan.jsonl"], { table: fakeTable(rows), s3: fakeS3(docs) });

    expect(result.exitCode).toBe(1);
    expect(result.summary).toMatchObject({ planned: 3, unreadable: 1 });
    expect(lines).toContain(`  unreadable ${CAREERS}: NoSuchKey: The specified key does not exist.`);
  });

  it("with --guid, reads only those bills", async () => {
    const { rows, docs } = world();
    const s3 = fakeS3(docs);
    const fs = files();
    const { result } = await run(["--guid", CAREERS, "--guid", CONDEMN, "--plan-file", "p.jsonl"], {
      table: fakeTable(rows),
      s3,
      fs,
    });

    expect(result.summary).toMatchObject({ rows: 2, planned: 1, notCeremonial: 1 });
    expect(parsePlanFile(fs.store.get("p.jsonl")!).map((line) => line.guid)).toEqual([CAREERS]);
  });

  it("writes no plan when there is nothing to relabel, and never overwrites one", async () => {
    const { docs } = world();
    const table = fakeTable([row(CLEAN, "2026-04-18T02:53:41.823Z")]);
    const { result, lines } = await run(["--plan-file", "p.jsonl"], { table, s3: fakeS3(docs) });
    expect(result.planFile).toBeUndefined();
    expect(lines).toContain("Plan: no ceremonial resolution row has topics or life areas; no plan file written");

    const second = await dryRun();
    await expect(
      run(["--plan-file", "plan.jsonl"], { table: second.table, s3: second.s3, fs: second.fs }),
    ).rejects.toThrow("EEXIST");
  });
});

describe("--apply", () => {
  const applied = async (argv: string[] = []) => {
    const planned = await dryRun();
    const sqs = fakeSqs();
    const before = new Map([...planned.table.items].map(([key, item]) => [key, structuredClone(item)]));
    planned.table.commands.length = 0;
    planned.s3.keys.length = 0;
    const out = await run(["--apply", "--plan-file", "plan.jsonl", "--undo-file", "undo.jsonl", ...argv], {
      table: planned.table,
      s3: planned.s3,
      sqs,
      fs: planned.fs,
    });
    return { ...out, table: planned.table, s3: planned.s3, sqs, before };
  };

  it("empties the planned lists of each planned row and changes nothing else: no key, date, version or count", async () => {
    const { result, table, before } = await applied();

    expect(result.exitCode).toBe(0);
    expect(result.applied).toEqual({ applied: 4, alreadyApplied: 0, superseded: 0, moved: 0, failed: 0 });
    // Same keys: no row moved, none added or removed.
    expect([...table.items.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [key, after] of table.items) {
      const was = before.get(key)!;
      const guid = was.guid.S!;
      const expected = structuredClone(was);
      if ([CAREERS, HEART, HONOR, LEGACY].includes(guid)) {
        if (was.subCategories.L!.length > 0) expected.subCategories = { L: [] };
        if (was.lifeAreas.L!.length > 0) expected.lifeAreas = { L: [] };
      }
      expect({ guid, row: after }).toEqual({ guid, row: expected });
    }
  });

  it("writes nothing but the BILL rows: no S3 object (no BillsManifestQueue event, so no push) and no SQS send", async () => {
    const { table, s3, sqs } = await applied();

    expect(s3.keys).toEqual([]);
    expect(new Set(table.names())).toEqual(new Set(["GetItemCommand", "UpdateItemCommand"]));
    expect(sqs.names).toEqual([
      "GetQueueUrlCommand",
      "GetQueueAttributesCommand",
      "GetQueueUrlCommand",
      "GetQueueAttributesCommand",
    ]);
    const updates = table.commands.filter((command) => command.name === "UpdateItemCommand");
    expect(updates).toHaveLength(4);
    for (const { input } of updates) {
      expect(input.Key!.pk).toEqual({ S: "BILL" });
      // Only the two lists are set, never updatedAt, the key, the version or the vote count.
      const setNames = String(input.UpdateExpression)
        .replace(/^SET /, "")
        .split(/,\s*/)
        .map((clause) => input.ExpressionAttributeNames![clause.split(" = ")[0]]);
      expect(setNames.every((name) => name === "subCategories" || name === "lifeAreas")).toBe(true);
    }
  });

  it("applies only the lines left in a reviewed plan file: a row the review takes out is not written", async () => {
    const planned = await dryRun();
    // RUNBOOK 4.12, step 2: jq -c 'select(.guid != "...")' "$PLAN" > "$REVIEWED"
    const reviewed = planned.fs.store
      .get("plan.jsonl")!
      .split("\n")
      .filter((line) => line && JSON.parse(line).guid !== HEART)
      .map((line) => `${line}\n`)
      .join("");
    planned.fs.store.set("reviewed.jsonl", reviewed);
    const heartSk = planned.rows.find((item) => item.guid.S === HEART)!.sk.S!;
    const heartBefore = structuredClone(planned.table.items.get(heartSk));
    planned.table.commands.length = 0;

    const { result } = await run(["--apply", "--plan-file", "reviewed.jsonl", "--undo-file", "undo.jsonl"], {
      table: planned.table,
      fs: planned.fs,
    });

    expect(result.applied).toEqual({ applied: 3, alreadyApplied: 0, superseded: 0, moved: 0, failed: 0 });
    expect(planned.table.items.get(heartSk)).toEqual(heartBefore);
    expect(
      planned.table.commands.filter((command) => command.name === "UpdateItemCommand").map((c) => c.input.Key!.sk.S),
    ).not.toContain(heartSk);
  });

  it("is idempotent: a rerun reports every row alreadyApplied and writes nothing", async () => {
    const first = await applied();
    first.table.commands.length = 0;

    const { result } = await run(["--apply", "--plan-file", "plan.jsonl", "--undo-file", "undo-2.jsonl"], {
      table: first.table,
      fs: first.fs,
    });

    expect(result.applied).toEqual({ applied: 0, alreadyApplied: 4, superseded: 0, moved: 0, failed: 0 });
    expect(first.table.names().filter((name) => name === "UpdateItemCommand")).toEqual([]);
    expect(first.fs.store.get("undo-2.jsonl")).toBe("");
  });

  it("writes an undo record per applied row, with what it held", async () => {
    const { fs } = await applied();
    const records = fs.store
      .get("undo.jsonl")!
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(records.map((record) => [record.guid, record.before, record.appliedAt])).toEqual([
      [HEART, { subCategories: ["Healthcare"], lifeAreas: ["Health Insurance", "Medical Costs"] }, NOW.toISOString()],
      [CAREERS, { subCategories: ["Education", "Labor and Employment"] }, NOW.toISOString()],
      [HONOR, { lifeAreas: ["Student Loans"] }, NOW.toISOString()],
      [LEGACY, { subCategories: ["Healthcare"] }, NOW.toISOString()],
    ]);
  });

  it("paces the writes at --rate", async () => {
    const { sleep } = await applied(["--rate", "2"]);
    // Four rows two a second, with a clock that does not move: three waits of 500 ms.
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([500, 1000, 1500]);
  });

  it("with --guid, relabels only that row of the plan", async () => {
    const { result, table } = await applied(["--guid", CAREERS]);

    expect(result.applied).toMatchObject({ applied: 1 });
    expect(table.items.get(`${DATED}#${CAREERS}`)!.subCategories).toEqual({ L: [] });
    expect(table.items.get(`2026-03-19T18:41:25.739Z#${HEART}`)!.subCategories).toEqual(list(["Healthcare"]));
  });

  it("refuses to start while a manifest queue holds messages, and writes nothing", async () => {
    const busy: Array<Record<string, [number, number, number]>> = [
      { BillsManifestQueue: [1, 0, 0] },
      { BillsManifestQueue: [0, 1, 0] },
      { BillsManifestDLQ: [0, 0, 1] },
    ];
    for (const depths of busy) {
      const planned = await dryRun();
      planned.table.commands.length = 0;
      const { result, logError, fs } = await run(["--apply", "--plan-file", "plan.jsonl"], {
        table: planned.table,
        sqs: fakeSqs(depths),
        fs: planned.fs,
      });

      expect(result.exitCode).toBe(2);
      expect(planned.table.commands).toEqual([]);
      expect([...fs.store.keys()]).toEqual(["plan.jsonl"]);
      expect(logError).toHaveBeenCalledWith(
        expect.stringContaining("Refusing to write: a manifest queue holds messages"),
      );
    }
  });

  it("refuses a plan made before a curated override or by an older rule, and writes nothing", async () => {
    // BILLS-119hres1365's line as the plans of 2026-10-29 before the curated overrides hold it (plan-1 to plan-3), and
    // BILLS-119hres930's as the first plan held it, before a headline that asks for something was left alone. Neither
    // row has changed since, so without the check the apply would take their topics off.
    const arfid = CURATED_CEREMONIAL_OVERRIDES.find(({ guid }) => guid === "BILLS-119hres1365")!;
    const stale: PlanLine[] = [
      {
        guid: arfid.guid,
        sk: `2026-06-12T13:49:05.033Z#${arfid.guid}`,
        billType: "hres",
        title: arfid.headline,
        officialTitle: null,
        before: { subCategories: ["Healthcare"] },
        version: {
          updatedAt: "2026-06-12T13:49:05.033Z",
          contentHash: "v1:0000000000000000:0000000000000000",
          dateBasis: "d1|New|2026-06-11||",
          documentStoredAt: "2026-06-12T13:49:05.033Z",
        },
      },
      {
        guid: ASKS,
        sk: `${DATED}#${ASKS}`,
        billType: "hres",
        title: "Celebrate Jimmy Lai and Free Hong Kong Activists",
        officialTitle: null,
        before: { subCategories: ["Freedom of Speech and Press", "Diplomacy"] },
        version: { updatedAt: DATED, contentHash: null, dateBasis: null, documentStoredAt: null },
      },
    ];
    const planned = await dryRun();
    planned.fs.store.set(
      "old-plan.jsonl",
      planned.fs.store.get("plan.jsonl")! + stale.map((line) => `${JSON.stringify(line)}\n`).join(""),
    );
    planned.table.commands.length = 0;
    const sqs = fakeSqs();

    const { result, lines, logError, fs } = await run(["--apply", "--plan-file", "old-plan.jsonl"], {
      table: planned.table,
      sqs,
      fs: planned.fs,
    });

    expect(result.exitCode).toBe(2);
    expect(planned.table.commands).toEqual([]);
    expect(sqs.names).toEqual([]);
    expect([...fs.store.keys()].sort()).toEqual(["old-plan.jsonl", "plan.jsonl"]);
    expect(lines).toEqual(
      expect.arrayContaining([
        "  not ceremonial now: BILLS-119hres1365 (curated override) topics [Healthcare] -> []",
        "  not ceremonial now: BILLS-119hres930 (headline) topics [Freedom of Speech and Press, Diplomacy] -> []",
      ]),
    );
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining("Refusing to write: 2 line(s) of the plan are not ceremonial under this release's rule"),
    );

    // The plan without them (the dry run's own) applies.
    const fresh = await run(["--apply", "--plan-file", "plan.jsonl", "--undo-file", "undo.jsonl"], {
      table: planned.table,
      fs: planned.fs,
    });
    expect(fresh.result.applied).toMatchObject({ applied: 4, failed: 0 });
  });

  it("leaves a row that changed since the dry run: another version, other lists, or a moved row", async () => {
    const planned = await dryRun();
    const careersSk = `${DATED}#${CAREERS}`;
    const heartSk = `2026-03-19T18:41:25.739Z#${HEART}`;
    const legacySk = `2026-03-19T16:39:17.097Z#${LEGACY}`;
    // A newer version without news, kept at the row's date by an older CreateBillsManifest: another hash, its topics.
    planned.table.items.get(careersSk)!.contentHash = { S: "v1:1111111111111111:2222222222222222" };
    // The summary was redone with other topics.
    planned.table.items.get(heartSk)!.subCategories = list(["Healthcare", "Research and Innovation"]);
    // A real action moved the row to a new key.
    const moved = structuredClone(planned.table.items.get(legacySk)!);
    planned.table.items.delete(legacySk);
    moved.sk = { S: `2026-10-29T12:00:00.000Z#${LEGACY}` };
    planned.table.items.set(moved.sk.S!, moved);
    planned.table.commands.length = 0;

    const { result } = await run(["--apply", "--plan-file", "plan.jsonl"], { table: planned.table, fs: planned.fs });

    expect(result.applied).toEqual({ applied: 1, alreadyApplied: 0, superseded: 2, moved: 1, failed: 0 });
    expect(planned.table.items.get(careersSk)!.subCategories).toEqual(list(["Education", "Labor and Employment"]));
    expect(planned.table.items.get(moved.sk.S!)!.subCategories).toEqual(list(["Healthcare"]));
    expect(planned.table.names().filter((name) => name === "UpdateItemCommand")).toHaveLength(1);
  });

  it("does not write over a CreateBillsManifest write that lands between its read and its write", async () => {
    const planned = await dryRun();
    const careersSk = `${DATED}#${CAREERS}`;
    planned.table.onNextUpdate(() => {
      // An older CreateBillsManifest rewrites the row in place from a newer version.
      const current = planned.table.items.get(careersSk)!;
      current.contentHash = { S: "v1:3333333333333333:4444444444444444" };
      current.documentStoredAt = { S: "2026-10-29T17:59:00.000Z" };
    });

    const { result } = await run(["--apply", "--plan-file", "plan.jsonl", "--guid", CAREERS], {
      table: planned.table,
      fs: planned.fs,
    });

    expect(result.applied).toMatchObject({ applied: 0, superseded: 1 });
    expect(planned.table.items.get(careersSk)!.subCategories).toEqual(list(["Education", "Labor and Employment"]));
  });

  it("reports a failed write, exits 1 and goes on", async () => {
    const planned = await dryRun();
    const send = planned.table.db.send;
    planned.table.db.send = jest.fn(async (command: FakeCommand<FakeDynamoInput>) => {
      if (command.constructor.name === "UpdateItemCommand" && command.input.Key!.sk.S!.endsWith(CAREERS)) {
        throw Object.assign(new Error("Throughput exceeded"), { name: "ProvisionedThroughputExceededException" });
      }
      return send(command);
    });

    const { result, logError } = await run(["--apply", "--plan-file", "plan.jsonl"], {
      table: planned.table,
      fs: planned.fs,
    });

    expect(result.exitCode).toBe(1);
    expect(result.applied).toEqual({ applied: 3, alreadyApplied: 0, superseded: 0, moved: 0, failed: 1 });
    expect(logError).toHaveBeenCalledWith(
      "Failed to relabel the manifest row",
      expect.objectContaining({ guid: CAREERS }),
    );
  });

  it("starts no new row once interrupted", async () => {
    const planned = await dryRun();
    let calls = 0;
    const { result } = await run(["--apply", "--plan-file", "plan.jsonl"], {
      table: planned.table,
      fs: planned.fs,
      interrupted: () => ++calls > 2,
    });

    expect(result.applied).toMatchObject({ applied: 2 });
    expect(result.remaining).toBe(2);
  });
});

describe("--undo", () => {
  const appliedWorld = async () => {
    const planned = await dryRun();
    await run(["--apply", "--plan-file", "plan.jsonl", "--undo-file", "undo.jsonl"], {
      table: planned.table,
      fs: planned.fs,
    });
    planned.table.commands.length = 0;
    return planned;
  };

  it("is a dry run without --apply: says what it would put back and writes nothing", async () => {
    const { table, fs } = await appliedWorld();

    const { result } = await run(["--undo", "undo.jsonl"], { table, fs });

    expect(result.undone).toMatchObject({ wouldRestore: 4, restored: 0 });
    expect(new Set(table.names())).toEqual(new Set(["GetItemCommand"]));
  });

  it("puts the lists back on rows still as the relabel left them, and leaves any other", async () => {
    const { table, fs, rows } = await appliedWorld();
    // CreateBillsManifest (an older release) wrote the Careers row's topics back since.
    table.items.get(`${DATED}#${CAREERS}`)!.subCategories = list(["Education"]);

    const { result } = await run(["--undo", "undo.jsonl", "--apply"], { table, fs });

    expect(result.undone).toMatchObject({ restored: 3, changedSince: 1 });
    for (const original of rows.filter((item) => [HEART, HONOR, LEGACY].includes(item.guid.S!))) {
      expect(table.items.get(original.sk.S!)).toEqual(original);
    }
    expect(table.items.get(`${DATED}#${CAREERS}`)!.subCategories).toEqual(list(["Education"]));
  });

  it("takes a plan file too (a row written before its undo record was)", async () => {
    const { table, fs, rows } = await appliedWorld();

    const { result } = await run(["--undo", "plan.jsonl", "--apply"], { table, fs });

    expect(result.undone).toMatchObject({ restored: 4 });
    for (const original of rows) expect(table.items.get(original.sk.S!)).toEqual(original);
  });

  it("refuses to write while a manifest queue holds messages", async () => {
    const { table, fs } = await appliedWorld();
    const { result } = await run(["--undo", "undo.jsonl", "--apply"], {
      table,
      fs,
      sqs: fakeSqs({ BillsManifestDLQ: [1, 0, 0] }),
    });
    expect(result.exitCode).toBe(2);
    expect(table.commands).toEqual([]);
  });
});

describe("parsePlanFile", () => {
  const line: PlanLine = {
    guid: CAREERS,
    sk: `${DATED}#${CAREERS}`,
    billType: "hres",
    title: "t",
    officialTitle: null,
    before: { subCategories: ["Education"] },
    version: { updatedAt: DATED, contentHash: null, dateBasis: null, documentStoredAt: null },
  };

  it("reads its own lines", () => {
    expect(parsePlanFile(`${JSON.stringify(line)}\n\n`)).toEqual([line]);
  });

  it.each([
    ["a row of another guid", { sk: `${DATED}#BILLS-119hres1` }],
    ["nothing to empty", { before: {} }],
    ["an empty list", { before: { subCategories: [] } }],
    ["another attribute", { before: { title: ["x"] } }],
    ["no version", { version: undefined }],
    ["no updatedAt", { version: { ...line.version, updatedAt: null } }],
  ])("refuses a line with %s", (_name, change) => {
    expect(() => parsePlanFile(JSON.stringify({ ...line, ...change }))).toThrow(/Plan line 1/);
  });
});
