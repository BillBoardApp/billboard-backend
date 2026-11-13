import {
  buildBedrockRequestBody,
  countSentences,
  extractJsonPayload,
  extractMinimalBillInfo,
  extractReducedBillInfo,
  fieldFitRank,
  fieldOverage,
  fitText,
  getCorrectionPrompt,
  getSystemPrompt,
  getUserPrompt,
  interpretModelOutput,
  matchAnalysesToBills,
  mergeRevision,
  MinimalBillInput,
  NO_STATED_PURPOSE,
  parseBedrockResponse,
  repairAnalysis,
  roundAxisScore,
  salvageBillObjects,
  splitSentences,
  validateAnalysis,
  type AnalysisIssue,
  type BedrockBillAnalysis,
} from "../handlers/billSummarizer/prompts";
import { findLoadedWords, LOADED_WORDS } from "../handlers/billSummarizer/loadedWords";
import { BILL_CATEGORY_DEFINITIONS, LEGACY_SUB_CATEGORY_ALIASES } from "../models/categories";
import type { RawBill } from "../models/bill";

const validAnalysis = (guid: string, overrides: Record<string, unknown> = {}) => ({
  guid,
  title: "Funds broadband grants for rural areas",
  billBreakdown: {
    who: "Rural internet providers and the households they serve.",
    what: "Creates a grant program for rural broadband.",
    how: "The Department of Agriculture gives grants of up to $10 million.",
    when: "The provided text does not say.",
    where: "Rural areas of the United States.",
    why: "The bill states its purpose is to expand broadband in rural areas.",
  },
  soWhat: "Rural homes could get faster internet. Providers must report prices and speeds.",
  subCategories: ["Telecommunications"],
  lifeAreas: ["Digital Services"],
  civicProfile: { localVsFederal: 0.5 },
  ...overrides,
});

const FILLER = ["bill", "funds", "grants", "for", "rural", "clinics", "and", "requires", "yearly", "reports"];

/** One sentence of exactly `chars` characters per length, joined by spaces. */
const sentences = (...lengths: number[]): string =>
  lengths
    .map((chars) => {
      let text = "The";
      for (let i = 0; text.length < chars - 1; i += 1) text += ` ${FILLER[i % FILLER.length]}`;
      return `${text.slice(0, chars - 1).replace(/ $/, "s")}.`;
    })
    .join(" ");

const sampleBills: MinimalBillInput[] = [
  {
    guid: "BILLS-119hr9999ih",
    title: "Rural Communities Investment Act of 2025",
    officialTitle: "To provide for rural broadband programs, and for other purposes.",
    description: "Introduced in House",
    textSnippet: "Sec. 1. Short title\nThis Act may be cited as the Rural Communities Investment Act of 2025.",
    textComplete: true,
    hasText: true,
  },
  {
    guid: "BILLS-119s42is",
    title: "Omnibus Example Act",
    textSnippet: "TITLE I—Example\nSec. 101. Example section\n[12 more sections not shown]",
    textComplete: false,
    hasText: true,
  },
];

/** The fixtures here are deliberately partial raw bills (legacy shapes, only the fields a case reads). */
const partialRawBill = (doc: object): RawBill => doc as RawBill;

describe("billSummarizer extractMinimalBillInfo", () => {
  it("tolerates missing metadata (legacy raw shape) and extracts text instead of raw XML", () => {
    const legacyRawBill = {
      schemaVersion: 1,
      kind: "raw",
      storedAt: "2026-01-25T00:00:00Z",
      identifier: { congress: "119", billType: "house-bill", billNumber: "1" },
      guid: "BILLS-119hr1is",
      title: "Legacy Title",
      content: { billXML: "<xml>hello</xml>" },
    };

    const minimal = extractMinimalBillInfo(partialRawBill(legacyRawBill));
    expect(minimal.guid).toBe("BILLS-119hr1is");
    expect(minimal.title).toBe("Legacy Title");
    expect(minimal.textSnippet).toBe("hello");
    expect(minimal.hasText).toBe(true);
    expect(minimal.textComplete).toBe(true);
  });

  it("reads the official title from the XML and honours the guid override", () => {
    const rawBill = {
      metadata: { guid: "BILLS-119hr5", title: "Short Title Act", description: "Introduced" },
      content: {
        billXML:
          '<?xml version="1.0"?><bill><form><legis-type>A BILL</legis-type><official-title>To amend title 10, United States Code.</official-title></form><legis-body><section><enum>1.</enum><header>Short title</header><text>This Act may be cited as the Short Title Act.</text></section></legis-body></bill>',
      },
    };

    const minimal = extractMinimalBillInfo(partialRawBill(rawBill), 16_000, " BILLS-119hr5ih ");
    expect(minimal).toEqual({
      guid: "BILLS-119hr5ih",
      title: "Short Title Act",
      officialTitle: "To amend title 10, United States Code.",
      description: "Introduced",
      textSnippet: "Sec. 1. Short title\nThis Act may be cited as the Short Title Act.",
      textComplete: true,
      hasText: true,
    });
  });

  it("marks a bill without billXML as having no text instead of sending its metadata", () => {
    const rawBill = {
      metadata: { guid: "BILLS-119hr6", title: "No Text Yet Act" },
      content: { bill: { bill: { title: "No Text Yet Act" } }, actions: { actions: [] } },
    };

    const minimal = extractMinimalBillInfo(partialRawBill(rawBill));
    expect(minimal.textSnippet).toBe("");
    expect(minimal.hasText).toBe(false);
    expect(minimal.textComplete).toBe(false);
  });

  it("flags shortened text as incomplete", () => {
    const sections = Array.from(
      { length: 40 },
      (_, i) =>
        `<section><enum>${i + 1}.</enum><header>Part ${i + 1}</header><text>${"Words about the program. ".repeat(20)}</text></section>`,
    ).join("");
    const rawBill = {
      metadata: { guid: "BILLS-119hr7", title: "Long Act" },
      content: { billXML: `<bill><legis-body>${sections}</legis-body></bill>` },
    };

    const minimal = extractMinimalBillInfo(partialRawBill(rawBill), 2_000);
    expect(minimal.textSnippet.length).toBeLessThanOrEqual(2_000);
    expect(minimal.textComplete).toBe(false);
  });

  it("shortens the text to 4,000 characters for the retry after a refusal, and always marks it incomplete", () => {
    const sections = Array.from(
      { length: 40 },
      (_, i) =>
        `<section><enum>${i + 1}.</enum><header>Part ${i + 1}</header><text>${"Words about the program. ".repeat(20)}</text></section>`,
    ).join("");
    const long = {
      metadata: { guid: "BILLS-119hr7", title: "Long Act" },
      content: { billXML: `<bill>${sections}</bill>` },
    };
    const short = { metadata: { guid: "BILLS-119hr8", title: "Short Act" }, content: { billXML: "<xml>hello</xml>" } };

    const reduced = extractReducedBillInfo(partialRawBill(long), "BILLS-119hr7ih");
    expect(reduced.guid).toBe("BILLS-119hr7ih");
    expect(reduced.textSnippet.length).toBeLessThanOrEqual(4_000);
    expect(reduced.textSnippet.length).toBeGreaterThan(3_000);
    expect(reduced.textComplete).toBe(false);
    // A short bill keeps its whole text but is still flagged, so the retry differs from the refused request.
    expect(extractReducedBillInfo(partialRawBill(short))).toMatchObject({ textSnippet: "hello", textComplete: false });
  });
});

describe("billSummarizer prompts", () => {
  it("renders the system prompt (snapshot)", () => {
    expect(getSystemPrompt()).toMatchSnapshot();
  });

  it("renders the user prompt (snapshot)", () => {
    expect(getUserPrompt(sampleBills)).toMatchSnapshot();
  });

  it("carries the neutrality, purpose, title, reading-level and rubric rules", () => {
    const prompt = getSystemPrompt();

    expect(prompt).toContain("Do not say whether the bill is good or bad");
    expect(prompt).toContain('write "the bill states"');
    expect(prompt).toContain("never mention or infer a political party");
    expect(prompt).toContain("name both groups");
    expect(prompt).toContain('("textComplete": false)');
    expect(prompt).toContain("What the bill's text states as its purpose");
    expect(prompt).toContain(NO_STATED_PURPOSE);
    expect(prompt).toContain("Describe, do not evaluate.");
    expect(prompt).toContain("7th-grade reading level");
    expect(prompt).toContain("under 20 words");
    // REL-40: the prompt asks for less than the validator's limits (100, 280 and 400 characters).
    expect(prompt).toContain("4 to 10 words and at most 80 characters");
    expect(prompt).toContain("each field 1-2 sentences and at most 300 characters, about 45 words; shorter is fine");
    expect(prompt).toContain("the one or two most important mechanisms");
    expect(prompt).toContain("Do not list every provision");
    expect(prompt).toContain("At most 2 short sentences and 240 characters (about 40 words).");
    expect(prompt).not.toMatch(/\b(?:280|400) characters/);
    expect(prompt).toContain("Use only these values: -1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1.");
    for (const axis of [
      "individualVsCommunity",
      "localVsFederal",
      "freeMarketVsRegulated",
      "traditionalVsProgressive",
      "interventionistVsRestrained",
      "privacyVsSecurity",
    ]) {
      const block = prompt.slice(prompt.indexOf(`- ${axis}`));
      expect(block).toMatch(/-1 = .*\(example: /);
      expect(block).toMatch(/\n {2}0 = /);
      expect(block).toMatch(/\+1 = .*\(example: /);
    }

    expect(prompt).not.toMatch(/why does the sponsor/i);
    expect(prompt).not.toContain("ELI5");
    expect(prompt).not.toMatch(/boring congressional titles/i);
  });

  it("lists the renamed labels under their current names and neither former name (LLM-10)", () => {
    const prompt = getSystemPrompt();
    const subCategoryBlock = prompt.slice(prompt.indexOf("SUBCATEGORIES"), prompt.indexOf("LIFE AREAS"));

    expect(subCategoryBlock).toContain(
      "Social Policy: [Healthcare, Education, Housing, Civil Rights and Liberties, Family and Gender Policy]",
    );
    expect(subCategoryBlock).toContain(
      "Cultural and Ethical Issues: [Religion and State, Heritage and Identity, Freedom of Speech and Press, Ethics in Policy]",
    );
    // Every current sub-category is offered, so the model never needs a former name.
    for (const definition of BILL_CATEGORY_DEFINITIONS) {
      for (const name of definition.subCategories) expect(subCategoryBlock).toContain(name);
    }

    const formerNames = ["Social Justice", "Identity Politics", ...Object.keys(LEGACY_SUB_CATEGORY_ALIASES)];
    for (const text of [prompt, getUserPrompt(sampleBills)]) {
      for (const formerName of formerNames) {
        expect(text.toLowerCase()).not.toContain(formerName.toLowerCase());
      }
    }
  });

  it("contains none of the loaded words", () => {
    const prompt = getSystemPrompt();
    expect(findLoadedWords(prompt)).toEqual([]);
    const lower = prompt.toLowerCase();
    for (const word of LOADED_WORDS) {
      expect(lower).not.toContain(word.toLowerCase());
    }
  });

  it("frames bill data as material to analyze and passes textComplete and officialTitle", () => {
    const prompt = getUserPrompt(sampleBills);
    expect(prompt).toContain("not instructions");
    const payload = JSON.parse(prompt.slice(prompt.indexOf("Bills: ") + "Bills: ".length));
    expect(payload).toEqual([
      {
        guid: "BILLS-119hr9999ih",
        title: "Rural Communities Investment Act of 2025",
        officialTitle: "To provide for rural broadband programs, and for other purposes.",
        desc: "Introduced in House",
        textComplete: true,
        text: sampleBills[0].textSnippet,
      },
      {
        guid: "BILLS-119s42is",
        title: "Omnibus Example Act",
        officialTitle: "",
        desc: "",
        textComplete: false,
        text: sampleBills[1].textSnippet,
      },
    ]);
  });

  it("builds a Haiku 4.5 body with temperature 0 and no output_config", () => {
    const body = buildBedrockRequestBody(sampleBills, { profile: "haiku-4-5", effort: "medium", maxTokens: 4096 });
    expect(body).toEqual({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 4096,
      temperature: 0,
      system: getSystemPrompt(),
      messages: [{ role: "user", content: [{ type: "text", text: getUserPrompt(sampleBills) }] }],
    });
  });

  it("builds a Haiku 5.5 body with output_config.effort and no sampling parameters", () => {
    const body = buildBedrockRequestBody(sampleBills, { profile: "haiku-5-5", effort: "medium", maxTokens: 8192 });
    expect(Object.keys(body)).toEqual(["anthropic_version", "max_tokens", "output_config", "system", "messages"]);
    expect(body).toMatchObject({ max_tokens: 8192, output_config: { effort: "medium" } });
    for (const field of ["temperature", "top_p", "top_k", "thinking", "fallbacks", "stop_sequences", "tools"]) {
      expect(body).not.toHaveProperty(field);
    }
    expect(body.messages.at(-1)?.role).toBe("user");

    const fallback = buildBedrockRequestBody(sampleBills, { profile: "haiku-5-5", effort: "default", maxTokens: 8192 });
    expect(Object.keys(fallback)).toEqual(["anthropic_version", "max_tokens", "system", "messages"]);
  });

  it("builds the corrective call as a 3-turn conversation that replays the bill's answer as text and ends with the issues", () => {
    const previous = validAnalysis("BILLS-119hr9999ih", { soWhat: "Taxes rise. Prices fall. Jobs move." });
    const issues = (validateAnalysis(previous) as { issues: AnalysisIssue[] }).issues;
    for (const profile of ["haiku-4-5", "haiku-5-5"] as const) {
      const body = buildBedrockRequestBody(
        [sampleBills[0]],
        { profile, effort: "medium", maxTokens: 8192 },
        { previous, issues },
      );
      expect(body.messages).toEqual([
        { role: "user", content: [{ type: "text", text: getUserPrompt([sampleBills[0]]) }] },
        { role: "assistant", content: [{ type: "text", text: JSON.stringify({ bills: [previous] }) }] },
        { role: "user", content: [{ type: "text", text: getCorrectionPrompt(issues) }] },
      ]);
      expect(body.system).toBe(getSystemPrompt());
    }
  });

  it("names each broken limit in the correction prompt, with the limit and the target", () => {
    const issues = (
      validateAnalysis(
        validAnalysis("BILLS-119hr1", {
          title: "t".repeat(112),
          soWhat: "Taxes go up. Prices go down. Jobs change.",
          billBreakdown: { ...validAnalysis("x").billBreakdown, how: sentences(150, 130, 120, 131), why: "" },
        }),
      ) as { issues: AnalysisIssue[] }
    ).issues;

    expect(getCorrectionPrompt(issues)).toBe(`Your answer above breaks these rules:
- title is 112 characters. The limit is 100 characters; rewrite it in at most 80 characters.
- soWhat has 3 sentences. The limit is 2 sentences and 280 characters; rewrite it in at most 240 characters.
- billBreakdown.how is 534 characters in 4 sentences. The limit is 400 characters; rewrite it in at most 300 characters and 1-2 sentences.
- billBreakdown.why is missing or empty. Write it following the BILL BREAKDOWN RULES.
Rewrite only these fields. Keep the most important point and leave out lesser details; end each field with a complete sentence; keep every other rule in the system prompt. Return the complete JSON object in the same format, with every other field exactly as before.`);

    const longSoWhat = (
      validateAnalysis(validAnalysis("BILLS-119hr1", { soWhat: sentences(200, 106) })) as {
        issues: AnalysisIssue[];
      }
    ).issues;
    expect(getCorrectionPrompt(longSoWhat)).toContain(
      "- soWhat is 307 characters in 2 sentences. The limit is 2 sentences and 280 characters; rewrite it in at most 240 characters.",
    );
    expect(getCorrectionPrompt([{ field: "title", kind: "hard", rule: "missing" }])).toContain(
      "- title is missing or empty. Write it following the TITLE RULES.",
    );
  });
});

describe("billSummarizer response parsing", () => {
  const payload = JSON.stringify({ bills: [validAnalysis("BILLS-119hr1")] });

  it("parses plain JSON", () => {
    expect(parseBedrockResponse(payload)?.bills).toHaveLength(1);
  });

  it("strips a Markdown code fence (the live failure mode)", () => {
    expect(parseBedrockResponse("```json\n" + payload + "\n```")?.bills).toHaveLength(1);
    expect(parseBedrockResponse("```\n" + payload + "\n```")?.bills).toHaveLength(1);
    expect(
      parseBedrockResponse("Here is the analysis:\n\n```json\n" + payload + "\n```\nLet me know if you need more.")
        ?.bills,
    ).toHaveLength(1);
  });

  it("strips leading and trailing prose, including prose with braces", () => {
    expect(
      parseBedrockResponse(`Sure. ${payload}\n\nNote: {"bills"} were scored per the rubric {see above}.`)?.bills,
    ).toHaveLength(1);
    expect(extractJsonPayload(`Result:\n${payload} trailing`)).toBe(payload);
  });

  it("accepts a bare array of analyses", () => {
    expect(parseBedrockResponse(JSON.stringify([validAnalysis("BILLS-119hr1")]))?.bills).toHaveLength(1);
  });

  it("returns null for truncated or non-JSON output", () => {
    expect(parseBedrockResponse(payload.slice(0, payload.length - 40))).toBeNull();
    expect(parseBedrockResponse("```json\n" + payload.slice(0, 200))).toBeNull();
    expect(parseBedrockResponse("I cannot analyze these bills.")).toBeNull();
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(parseBedrockResponse(JSON.stringify({ results: [] }))).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith("Invalid Bedrock response structure: missing bills array");
    } finally {
      warn.mockRestore();
    }
  });

  it("salvages the bills completed before a max_tokens cut", () => {
    const full = JSON.stringify({
      bills: [
        validAnalysis("BILLS-119hr1"),
        validAnalysis("BILLS-119hr2", { soWhat: 'Text with "quotes" and } braces.' }),
      ],
    });
    const cut = full.slice(0, full.indexOf("BILLS-119hr2") + 60);
    expect(salvageBillObjects(cut)).toEqual([validAnalysis("BILLS-119hr1")]);
    // Cut after the second object closed but before "]}".
    expect(salvageBillObjects("```json\n" + full.slice(0, full.length - 2))).toHaveLength(2);
    expect(salvageBillObjects("no json here")).toEqual([]);
  });

  it("interprets stop_reason max_tokens as incomplete even when some bills parsed", () => {
    const full = JSON.stringify({ bills: [validAnalysis("BILLS-119hr1"), validAnalysis("BILLS-119hr2")] });
    const cut = full.slice(0, full.indexOf("BILLS-119hr2") + 30);
    const output = interpretModelOutput(cut, "max_tokens", ["BILLS-119hr1", "BILLS-119hr2"]);
    expect(output.complete).toBe(false);
    expect(output.truncated).toBe(true);
    expect(output.parsed).toBe(false);
    expect([...output.analyses.keys()]).toEqual(["BILLS-119hr1"]);

    const whole = interpretModelOutput(full, "max_tokens", ["BILLS-119hr1", "BILLS-119hr2"]);
    expect(whole.complete).toBe(false);
    expect(whole.analyses.size).toBe(2);

    expect(interpretModelOutput(full, "end_turn", ["BILLS-119hr1", "BILLS-119hr2"]).complete).toBe(true);
  });

  it("returns no analysis from a refusal, even when its partial content parses", () => {
    const full = JSON.stringify({ bills: [validAnalysis("BILLS-119hr1")] });
    expect(interpretModelOutput(full, "refusal", ["BILLS-119hr1"])).toEqual({
      analyses: new Map(),
      complete: false,
      truncated: false,
      parsed: false,
      refused: true,
      unmatchedGuids: [],
    });
    expect(interpretModelOutput(full, "end_turn", ["BILLS-119hr1"]).refused).toBe(false);
  });

  it("matches analyses to requested guids and reports mismatches", () => {
    const { analyses, unmatchedGuids } = matchAnalysesToBills(
      [
        validAnalysis("bills-119hr1ih"),
        validAnalysis("BILLS-119hr999"),
        validAnalysis("BILLS-119hr1ih", { title: "Duplicate" }),
        { title: "no guid" },
      ],
      ["BILLS-119hr1ih", "BILLS-119hr2ih"],
    );
    expect([...analyses.keys()]).toEqual(["BILLS-119hr1ih"]);
    expect((analyses.get("BILLS-119hr1ih") as { guid: string }).guid).toBe("bills-119hr1ih");
    expect(unmatchedGuids).toEqual(["BILLS-119hr999", "(missing guid)"]);
  });
});

describe("billSummarizer validateAnalysis", () => {
  it("accepts a valid analysis and normalizes whitespace", () => {
    const result = validateAnalysis(validAnalysis("BILLS-119hr1", { title: "  Funds   broadband\ngrants  " }));
    expect(result).toEqual({
      ok: true,
      analysis: { ...validAnalysis("BILLS-119hr1"), title: "Funds broadband grants" },
    });
  });

  it("defaults missing or malformed arrays to [] instead of throwing", () => {
    const candidate: Record<string, unknown> = validAnalysis("BILLS-119hr1");
    delete candidate.subCategories;
    candidate.lifeAreas = "Taxes";
    delete candidate.civicProfile;

    const result = validateAnalysis(candidate);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.analysis.subCategories).toEqual([]);
    expect(result.analysis.lifeAreas).toEqual([]);
    expect(result.analysis).not.toHaveProperty("civicProfile");
  });

  it("drops unknown and duplicate tags and keeps at most three", () => {
    const result = validateAnalysis(
      validAnalysis("BILLS-119hr1", {
        subCategories: ["Energy", "Made Up", "Energy", 7, " Healthcare ", "Education", "Housing"],
        lifeAreas: ["Taxes", "Not A Life Area"],
      }),
    );
    expect(result.ok && result.analysis.subCategories).toEqual(["Energy", "Healthcare", "Education"]);
    expect(result.ok && result.analysis.lifeAreas).toEqual(["Taxes"]);
  });

  it("stores a former sub-category name under its current name (LLM-10)", () => {
    const result = validateAnalysis(
      validAnalysis("BILLS-119hr1", { subCategories: [" Social Justice ", "Identity Politics", "Energy"] }),
    );
    expect(result.ok && result.analysis.subCategories).toEqual([
      "Civil Rights and Liberties",
      "Heritage and Identity",
      "Energy",
    ]);
  });

  it("counts a former and a current name for one label once, in first-seen order, before the limit of three", () => {
    const result = validateAnalysis(
      validAnalysis("BILLS-119hr1", {
        subCategories: ["Social Justice", "Energy", "Civil Rights and Liberties", "Healthcare", "Housing"],
      }),
    );
    expect(result.ok && result.analysis.subCategories).toEqual(["Civil Rights and Liberties", "Energy", "Healthcare"]);
  });

  it("does not map former names in the life areas, and still drops near-miss spellings", () => {
    const result = validateAnalysis(
      validAnalysis("BILLS-119hr1", {
        subCategories: ["social justice", "Social Justice Policy", "Identity  Politics"],
        lifeAreas: ["Social Justice", "Taxes"],
      }),
    );
    expect(result.ok && result.analysis.subCategories).toEqual([]);
    expect(result.ok && result.analysis.lifeAreas).toEqual(["Taxes"]);
  });

  it("keeps known axes only, clamped and rounded to 0.25", () => {
    const result = validateAnalysis(
      validAnalysis("BILLS-119hr1", {
        civicProfile: {
          localVsFederal: 0.38,
          individualVsCommunity: -0.13,
          freeMarketVsRegulated: 1.7,
          privacyVsSecurity: "0.6",
          traditionalVsProgressive: 0.1,
          interventionistVsRestrained: "high",
          madeUpAxis: 0.5,
        },
      }),
    );
    expect(result.ok && result.analysis.civicProfile).toEqual({
      localVsFederal: 0.5,
      individualVsCommunity: -0.25,
      freeMarketVsRegulated: 1,
      privacyVsSecurity: 0.5,
      traditionalVsProgressive: 0,
    });
    expect(validateAnalysis(validAnalysis("BILLS-119hr1", { civicProfile: { madeUpAxis: 1 } })).ok && true).toBe(true);
    const noAxes = validateAnalysis(validAnalysis("BILLS-119hr1", { civicProfile: [0.5] }));
    expect(noAxes.ok && noAxes.analysis).not.toHaveProperty("civicProfile");
  });

  it("rejects missing or empty required text", () => {
    const noTitle = validateAnalysis(validAnalysis("BILLS-119hr1", { title: "   " }));
    expect(noTitle).toEqual({
      ok: false,
      guid: "BILLS-119hr1",
      errors: ["title is missing or empty"],
      issues: [{ field: "title", kind: "hard", rule: "missing" }],
    });

    const noBreakdown = validateAnalysis(validAnalysis("BILLS-119hr1", { billBreakdown: undefined, soWhat: 5 }));
    expect(noBreakdown.ok).toBe(false);
    expect(!noBreakdown.ok && noBreakdown.errors).toEqual(["soWhat is missing or empty", "billBreakdown is missing"]);

    const partialBreakdown = validateAnalysis(validAnalysis("BILLS-119hr1", { billBreakdown: { who: "Farmers." } }));
    expect(!partialBreakdown.ok && partialBreakdown.errors).toEqual([
      "billBreakdown.what is missing or empty",
      "billBreakdown.how is missing or empty",
      "billBreakdown.when is missing or empty",
      "billBreakdown.where is missing or empty",
      "billBreakdown.why is missing or empty",
    ]);

    expect(validateAnalysis(null)).toEqual({
      ok: false,
      guid: "",
      errors: ["analysis is not an object"],
      issues: [{ field: "analysis", kind: "hard", rule: "not_object" }],
    });
    expect(validateAnalysis(validAnalysis(""))).toMatchObject({
      ok: false,
      errors: ["guid is missing"],
      issues: [{ field: "guid", kind: "hard", rule: "missing" }],
    });
    expect(noBreakdown).toMatchObject({
      issues: [
        { field: "soWhat", kind: "hard", rule: "missing" },
        { field: "billBreakdown", kind: "hard", rule: "missing" },
      ],
    });
  });

  it("enforces soWhat at most 2 sentences and 280 characters, and breakdown fields at most 400", () => {
    const threeSentences = validateAnalysis(
      validAnalysis("BILLS-119hr1", { soWhat: "Taxes go up. Prices go down. Jobs change." }),
    );
    expect(!threeSentences.ok && threeSentences.errors).toEqual(["soWhat has 3 sentences (max 2)"]);

    const longSoWhat = validateAnalysis(validAnalysis("BILLS-119hr1", { soWhat: "a".repeat(281) }));
    expect(!longSoWhat.ok && longSoWhat.errors).toEqual(["soWhat is 281 characters (max 280)"]);

    expect(validateAnalysis(validAnalysis("BILLS-119hr1", { soWhat: `${"a".repeat(279)}.` })).ok).toBe(true);

    const longWhy = validateAnalysis(
      validAnalysis("BILLS-119hr1", { billBreakdown: { ...validAnalysis("x").billBreakdown, why: "b".repeat(401) } }),
    );
    expect(!longWhy.ok && longWhy.errors).toEqual(["billBreakdown.why is 401 characters (max 400)"]);

    const longTitle = validateAnalysis(validAnalysis("BILLS-119hr1", { title: "t".repeat(101) }));
    expect(!longTitle.ok && longTitle.errors).toEqual(["title is 101 characters (max 100)"]);
  });

  it("describes each broken limit as a soft issue and builds the normalized analysis to fit", () => {
    const how = sentences(250, 214);
    const result = validateAnalysis(
      validAnalysis("BILLS-119hr1", {
        soWhat: "Taxes   go up. Prices go down. Jobs change.",
        billBreakdown: { ...validAnalysis("x").billBreakdown, how },
        subCategories: ["Energy", "Made Up"],
        civicProfile: { localVsFederal: 0.38 },
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      errors: ["soWhat has 3 sentences (max 2)", "billBreakdown.how is 465 characters (max 400)"],
      issues: [
        {
          field: "soWhat",
          kind: "soft",
          rule: "max_sentences",
          chars: 41,
          sentences: 3,
          limit: 2,
          target: 240,
          text: "Taxes go up. Prices go down. Jobs change.",
        },
        {
          field: "billBreakdown.how",
          kind: "soft",
          rule: "max_chars",
          chars: 465,
          sentences: 2,
          limit: 400,
          target: 300,
          text: how,
        },
      ],
    });
    expect(!result.ok && result.normalized).toMatchObject({
      soWhat: "Taxes go up. Prices go down. Jobs change.",
      billBreakdown: { how },
      subCategories: ["Energy"],
      civicProfile: { localVsFederal: 0.5 },
    });

    const overBoth = validateAnalysis(validAnalysis("BILLS-119hr1", { soWhat: sentences(100, 100, 100) }));
    expect(!overBoth.ok && overBoth.issues.map((issue) => issue.rule)).toEqual(["max_chars", "max_sentences"]);

    // A hard issue next to a soft one: nothing to fit.
    const mixed = validateAnalysis(validAnalysis("BILLS-119hr1", { title: "", soWhat: "a".repeat(281) }));
    expect(!mixed.ok && mixed.issues.map((issue) => issue.kind)).toEqual(["hard", "soft"]);
    expect(mixed).not.toHaveProperty("normalized");
  });
});

describe("billSummarizer fitting over-limit fields (REL-40)", () => {
  const breakdown = validAnalysis("x").billBreakdown;
  const analysisWith = (overrides: Record<string, unknown>): BedrockBillAnalysis => {
    const result = validateAnalysis(validAnalysis("BILLS-119hr1", overrides));
    if (result.ok) return result.analysis;
    if (!result.normalized) throw new Error("expected only soft issues");
    return result.normalized;
  };
  const issuesOf = (overrides: Record<string, unknown>): AnalysisIssue[] => {
    const result = validateAnalysis(validAnalysis("BILLS-119hr1", overrides));
    return result.ok ? [] : result.issues;
  };

  // Shapes seen in production rejections: total length, then the sentences it is made of.
  it.each([
    ["how 401", [250, 150], 250],
    ["how 415", [180, 150, 83], 331],
    ["how 464", [200, 263], 200],
    ["how 534", [120, 140, 130, 141], 392],
    ["how 662", [140, 130, 120, 150, 118], 392],
  ])("keeps the leading whole sentences of a breakdown field (%s)", (_label, lengths, keptChars) => {
    const how = sentences(...lengths);
    const fitted = fitText(how, 400);
    expect(fitted.method).toBe("sentences");
    expect(fitted.text).toHaveLength(keptChars);
    expect(how.startsWith(fitted.text)).toBe(true);
    expect(fitted.text.endsWith(".")).toBe(true);
  });

  it("keeps soWhat to its first sentences, then its characters", () => {
    expect(fitText("Taxes rise. Prices fall. Jobs move.", 280, 2)).toEqual({
      text: "Taxes rise. Prices fall.",
      method: "sentences",
    });
    // soWhat 281: two sentences, one kept.
    expect(fitText(sentences(150, 130), 280, 2)).toEqual({ text: sentences(150), method: "sentences" });
    // Three sentences whose first two are over the characters: one kept.
    expect(fitText(sentences(200, 100, 20), 280, 2).text).toBe(sentences(200));
  });

  it("cuts a first sentence that is alone over the limit at a word and ends it with an ellipsis", () => {
    // soWhat 307 as one sentence; a breakdown field of one 450-character sentence.
    for (const [text, limit] of [
      [sentences(307), 280],
      [sentences(450), 400],
    ] as const) {
      const fitted = fitText(text, limit, 2);
      expect(fitted.method).toBe("words");
      expect(fitted.text.length).toBeLessThanOrEqual(limit);
      expect(fitted.text.length).toBeGreaterThan(limit / 2);
      expect(fitted.text).toMatch(/[a-z]…$/);
      expect(text.startsWith(fitted.text.slice(0, -1))).toBe(true);
      expect(countSentences(fitted.text)).toBe(1);
    }
    // No space past half the limit: a hard cut.
    expect(fitText("x".repeat(500), 400)).toEqual({ text: `${"x".repeat(399)}…`, method: "words" });
    // A hard cut never keeps half of a character outside the BMP.
    expect(fitText(`Renames the ${"\u{1D400}".repeat(60)}`, 100)).toEqual({
      text: `Renames the ${"\u{1D400}".repeat(43)}…`,
      method: "words",
    });
  });

  it("cuts a sentence with a place abbreviation at a word, not after the abbreviation", () => {
    const title =
      "Renames Ft. Liberty in North Carolina back to Fort Bragg and updates every federal map, sign and record";
    const fitted = fitText(title, 100);

    expect(title.length).toBeGreaterThan(100);
    expect(fitted.method).toBe("words");
    expect(fitted.text).toMatch(/^Renames Ft\. Liberty .*[a-z]…$/);
  });

  it("drops whole sentences after one that ends with an initialism", () => {
    const first = "The bill bars federal agencies from buying drones made by companies based outside the U.S.";
    const how = `${first} It also creates a $500 million grant program ${"for state and local police ".repeat(11)}to replace them.`;

    expect(how.length).toBeGreaterThan(400);
    expect(fitText(how, 400)).toEqual({ text: first, method: "sentences" });
  });

  it("leaves text within its limits as it is, apart from whitespace", () => {
    expect(fitText("  Not   Applicable ", 400)).toEqual({ text: "Not Applicable", method: "none" });
    expect(fitText("", 400)).toEqual({ text: "", method: "none" });
  });

  it("repairs each over-limit field, logs the original text, and leaves the rest untouched", () => {
    const how = sentences(300, 233);
    const overrides = {
      soWhat: "Taxes rise. Prices fall. Jobs move.",
      billBreakdown: { ...breakdown, how, where: "Not Applicable", why: NO_STATED_PURPOSE },
    };
    const repaired = repairAnalysis(analysisWith(overrides), issuesOf(overrides));

    expect(repaired?.analysis).toEqual({
      ...analysisWith(overrides),
      soWhat: "Taxes rise. Prices fall.",
      billBreakdown: { ...breakdown, how: sentences(300), where: "Not Applicable", why: NO_STATED_PURPOSE },
    });
    expect(repaired?.repairs).toEqual([
      {
        field: "soWhat",
        rules: ["max_sentences"],
        method: "sentences",
        beforeChars: 35,
        afterChars: 24,
        beforeSentences: 3,
        afterSentences: 2,
        original: "Taxes rise. Prices fall. Jobs move.",
      },
      {
        field: "billBreakdown.how",
        rules: ["max_chars"],
        method: "sentences",
        beforeChars: 534,
        afterChars: 300,
        beforeSentences: 2,
        afterSentences: 1,
        original: how,
      },
    ]);
    expect(validateAnalysis(repaired?.analysis).ok).toBe(true);
  });

  it("fits a title over 100 characters and repairs nothing when a field is missing", () => {
    const title = `Changes ${"rules ".repeat(20)}for farms`;
    const repaired = repairAnalysis(analysisWith({ title }), issuesOf({ title }));
    expect(repaired?.analysis.title.length).toBeLessThanOrEqual(100);
    expect(repaired?.analysis.title.endsWith("…")).toBe(true);
    expect(repaired?.repairs[0]).toMatchObject({ field: "title", method: "words", original: title });

    expect(repairAnalysis(analysisWith({}), [{ field: "title", kind: "hard", rule: "missing" }])).toBeNull();
  });

  it("measures overage as the share of characters over plus the sentences over", () => {
    expect(fieldOverage("billBreakdown.how", "a".repeat(400))).toBe(0);
    expect(fieldOverage("billBreakdown.how", "a".repeat(500))).toBeCloseTo(0.25);
    expect(fieldOverage("soWhat", "One. Two. Three.")).toBe(1);
    expect(fieldOverage("soWhat", "")).toBe(Number.POSITIVE_INFINITY);
    expect(fieldOverage("guid", "BILLS-119hr1")).toBe(0);
  });

  it("ranks a field's text by how it would be stored: as it is, whole sentences, cut mid-sentence, not at all", () => {
    expect(fieldFitRank("billBreakdown.how", sentences(400))).toBe(0);
    expect(fieldFitRank("billBreakdown.how", sentences(200, 209))).toBe(1);
    expect(fieldFitRank("billBreakdown.how", sentences(405))).toBe(2);
    expect(fieldFitRank("soWhat", "Taxes rise. Prices fall. Jobs change.")).toBe(1);
    expect(fieldFitRank("soWhat", "")).toBe(3);
    expect(fieldFitRank("guid", "BILLS-119hr1")).toBe(0);
  });

  it("merges only the named fields from the corrective answer", () => {
    const first = validAnalysis("BILLS-119hr1", {
      title: "First headline",
      soWhat: "One. Two. Three.",
      billBreakdown: { ...breakdown, how: "First how." },
    });
    const revision = validAnalysis("BILLS-119hr1", {
      title: "Revised headline",
      soWhat: "One. Two.",
      subCategories: ["Energy"],
      civicProfile: { privacyVsSecurity: 1 },
      billBreakdown: { ...breakdown, who: "Revised who.", how: "Revised how." },
    });

    expect(mergeRevision(first, revision, ["soWhat", "billBreakdown.how"])).toEqual({
      ...first,
      soWhat: "One. Two.",
      billBreakdown: { ...first.billBreakdown, how: "Revised how." },
    });
    expect(mergeRevision(first, revision, [])).toEqual(first);
    // A missing breakdown in the first answer is taken whole from the revision.
    expect(mergeRevision({ ...first, billBreakdown: null }, revision, ["billBreakdown"])).toMatchObject({
      billBreakdown: revision.billBreakdown,
      title: "First headline",
    });
    expect(mergeRevision("not an object", revision, ["analysis"])).toBe(revision);
    expect(mergeRevision(first, "not an object", ["soWhat"])).toBe(first);
  });
});

describe("billSummarizer countSentences and roundAxisScore", () => {
  it.each([
    ["", 0],
    ["One sentence without a period", 1],
    ["The U.S. Department of Agriculture pays $2.5 million. Farmers apply by Jan. 1.", 2],
    ["H.R. 1 changes taxes, e.g. the child credit.", 1],
    ["It ends. It starts again! Does it?", 3],
    ['He said "stop." Then it ended.', 2],
    // A sentence starts with an uppercase letter, a quote or a bracket, never a digit or lowercase letter.
    ["H. Res. 1329 sets debate rules. Nothing changes for most people.", 2],
    ["S. Con. Res. 7 sets a budget. Nothing changes yet.", 2],
    ["The Dept. of Labor writes rules. Workers get notice.", 2],
    ["Tribes in N.M. and Ariz. get more say. Effects are indirect.", 2],
    ["Grants go to Calif. Agencies in Tex. and Wash. State too.", 1],
    ["Taxes rise in 2027. 2028 brings more.", 1],
    ["It ends. (A new rule starts.) Fees fall.", 3],
    // Places, titles and ranks in names.
    ["Soldiers at Mt. Rainier and Ft. Lewis get new signs. Maps change.", 2],
    ["Honors Rev. Martin Luther King Jr. with a stamp.", 1],
    // An initialism ends a sentence before a common opener, and only then.
    ["Drones made by companies based outside the U.S. It also creates a grant program.", 2],
    ["Foreign nationals could be forced to leave the U.S. This could affect immigration cases.", 2],
    ["A museum will be built in Washington, D.C. Most Americans will not be affected.", 2],
    ["The U.S. Army buys drones.", 1],
    ["The U.S. Under Secretary of State reports.", 1],
    ["The U.S. A.I. Safety Institute writes rules.", 1],
  ])("counts %j as %i", (text, expected) => {
    expect(countSentences(text)).toBe(expected);
  });

  it("splits text at the sentence ends it counts", () => {
    expect(splitSentences("  The U.S. Dept. of Labor pays. Workers apply\nby Jan. 1. And then  ")).toEqual([
      "The U.S. Dept. of Labor pays.",
      "Workers apply\nby Jan. 1.",
      "And then",
    ]);
    expect(splitSentences("")).toEqual([]);
    expect(splitSentences("Families at Mt. Rainier and Ft. Lewis bases see new signs. Maps change.")).toEqual([
      "Families at Mt. Rainier and Ft. Lewis bases see new signs.",
      "Maps change.",
    ]);
  });

  it.each([
    [0.12, 0],
    [0.13, 0.25],
    [-0.12, 0],
    [-0.38, -0.5],
    [0.87, 0.75],
    [-3, -1],
    [2, 1],
  ])("rounds %d to %d", (value, expected) => {
    expect(roundAxisScore(value)).toBe(expected);
  });
});

describe("loaded words", () => {
  it("finds whole-word, case-insensitive hits and common variants", () => {
    // One entry per hit, in LOADED_WORDS order.
    expect(findLoadedWords("A Radical plan with handouts, a common sense fix and far left giveaways.")).toEqual([
      "radical",
      "far-left",
      "common-sense",
      "handout",
      "giveaway",
    ]);
    expect(findLoadedWords("MAGA and maga; forever chemicals")).toEqual(["MAGA", "MAGA", "forever"]);
    expect(findLoadedWords("An extremely large magazine about radically new pipes.")).toEqual([]);
    expect(findLoadedWords("")).toEqual([]);
  });
});
