import { BILL_TEXT_BUDGET_CHARS, extractBillText, waterFill } from "../handlers/billSummarizer/billText";

// GPO bill.dtd layout as served by congress.gov "Formatted XML": prolog,
// Dublin Core metadata, cover-page form, section 1 with a table of contents,
// findings and purpose, then titles with subtitles, sections, amendatory
// quoted blocks and a back-page endorsement. Title I is padded with long
// sections so the whole bill is several times the default budget.
const LONG_SECTION_COUNT = 250;

const longSection = (n: number): string => `
<section id="H${10000 + n}"><enum>1${String(n).padStart(3, "0")}.</enum><header>Broadband grant condition ${n}</header>
<subsection id="H${20000 + n}"><enum>(a)</enum><header>In general</header><text>As a condition of receiving a grant under section 101, an eligible entity shall comply with requirement number ${n}, which applies to the construction, operation, and maintenance of broadband infrastructure in a rural area.</text></subsection>
<subsection id="H${30000 + n}"><enum>(b)</enum><header>Reporting</header><text>Not later than 1 year after the date on which an eligible entity receives a grant, and annually thereafter, the entity shall submit to the Secretary a report describing compliance with requirement number ${n}, including the number of households and businesses served, the speeds offered, and the prices charged.</text>
<paragraph id="H${40000 + n}"><enum>(1)</enum><text>The Secretary shall make each report available to the public on the website of the Department of Agriculture.</text></paragraph>
<paragraph id="H${50000 + n}"><enum>(2)</enum><text>The Secretary may waive this subsection for an entity serving fewer than 500 households.</text></paragraph></subsection>
</section>`;

const gpoBillXml = (longSections = LONG_SECTION_COUNT): string => `<?xml version="1.0"?>
<?xml-stylesheet type="text/xsl" href="billres.xsl"?>
<!DOCTYPE bill PUBLIC "-//US Congress//DTDs/bill.dtd//EN" "bill.dtd">
<bill bill-stage="Introduced-in-House" dms-id="H7A1B2C3D4E5F60718293A4B5C6D7E8F9" public-private="public" key="H" bill-type="olc">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dublinCore>
<dc:title>119 HR 9999 IH: Rural Communities Investment Act of 2025</dc:title>
<dc:publisher>U.S. House of Representatives</dc:publisher>
<dc:date>2025-06-12</dc:date>
<dc:format>text/xml</dc:format>
<dc:language>EN</dc:language>
<dc:rights>Pursuant to Title 17 Section 105 of the United States Code, this file is not subject to copyright protection and is in the public domain.</dc:rights>
</dublinCore>
</metadata>
<form>
<distribution-code display="yes">I</distribution-code>
<congress>119th CONGRESS</congress>
<session>1st Session</session>
<legis-num>H. R. 9999</legis-num>
<current-chamber>IN THE HOUSE OF REPRESENTATIVES</current-chamber>
<action>
<action-date date="20250612">June 12, 2025</action-date>
<action-desc><sponsor name-id="X000001">Ms. Example</sponsor> (for herself and <cosponsor name-id="Y000002">Mr. Sample</cosponsor>) introduced the following bill; which was referred to the <committee-name committee-id="HAG00">Committee on Agriculture</committee-name>, and in addition to the Committee on <committee-name committee-id="HIF00">Energy and Commerce</committee-name></action-desc>
</action>
<legis-type>A BILL</legis-type>
<official-title>To provide for rural broadband, water infrastructure, and health care workforce programs, and for other purposes.</official-title>
</form>
<legis-body id="HB1A2C3D4E5F6" style="OLC">
<section id="H1" section-type="section-one"><enum>1.</enum><header>Short title; table of contents</header>
<subsection id="H2"><enum>(a)</enum><header>Short title</header><text display-inline="yes-display-inline">This Act may be cited as the <quote><short-title>Rural Communities Investment Act of 2025</short-title></quote>.</text></subsection>
<subsection id="H3"><enum>(b)</enum><header>Table of contents</header><text display-inline="yes-display-inline">The table of contents for this Act is as follows:</text>
<toc container-level="legis-body-container" quoted-block="no-quotes" lowest-level="section" regeneration="yes-regeneration">
<toc-entry idref="H1" level="section">Sec. 1. Short title; table of contents.</toc-entry>
<toc-entry idref="H5" level="section">Sec. 2. Findings.</toc-entry>
<toc-entry idref="H8" level="title">TITLE I—Rural Broadband</toc-entry>
<toc-entry idref="H9" level="subtitle">Subtitle A—Grants</toc-entry>
<toc-entry idref="H30" level="title">TITLE II—Water Infrastructure</toc-entry>
<toc-entry idref="H40" level="title">TITLE III—Health Care Workforce</toc-entry>
</toc></subsection></section>
<section id="H5"><enum>2.</enum><header>Findings</header><text display-inline="no-display-inline">Congress finds the following:</text>
<paragraph id="H6"><enum>(1)</enum><text>About 22 percent of rural households lack access to fixed broadband service.</text></paragraph>
<paragraph id="H6a"><enum>(2)</enum><text>Rural hospitals report staffing shortages in nursing &amp; primary care.</text></paragraph>
</section>
<section id="H7"><enum>3.</enum><header>Purpose</header><text display-inline="no-display-inline">The purpose of this Act is to expand broadband, water systems, and health care staffing in rural areas.</text></section>
<title id="H8" style="OLC"><enum>I</enum><header>Rural Broadband</header>
<subtitle id="H9"><enum>A</enum><header>Grants</header>
<section id="H10"><enum>101.</enum><header>Rural broadband grant program</header>
<subsection id="H11"><enum>(a)</enum><header>In general</header><text>The Secretary of Agriculture shall establish a program to award grants to eligible entities to deploy broadband service in rural areas<deleted-phrase> that are unserved</deleted-phrase>.</text></subsection>
<subsection id="H12"><enum>(b)</enum><header>Amount</header><text>A grant under this section may not exceed $10,000,000.</text></subsection>
</section>
${Array.from({ length: longSections }, (_, i) => longSection(i + 1)).join("\n")}
</subtitle>
</title>
<title id="H30" style="OLC"><enum>II</enum><header>Water Infrastructure</header>
<section id="H31"><enum>201.</enum><header>Lead service line replacement grants</header><text display-inline="no-display-inline">Section 306 of the Consolidated Farm and Rural Development Act (<external-xref legal-doc="usc" parsable-cite="usc/7/1926">7 U.S.C. 1926</external-xref>) is amended by adding at the end the following:</text>
<quoted-block style="OLC" id="H32" display-inline="no-display-inline">
<section id="H33"><enum>310J.</enum><header>Lead pipe grants</header><text display-inline="no-display-inline">The Secretary may make grants to rural water systems to replace lead service lines&#x2014;including the portion on private property.</text></section></quoted-block><after-quoted-block>.</after-quoted-block></section>
</title>
<title id="H40" style="OLC"><enum>III</enum><header>Health Care Workforce</header>
<section id="H41"><enum>301.</enum><header>Rural health care workforce loan repayment</header><text display-inline="no-display-inline">The Secretary of Health and Human Services shall repay up to $50,000 of the student loans of each nurse who agrees to work for 3 years in a rural health clinic. TAIL-SENTINEL-TEXT.</text></section>
<section id="H42"><enum>302.</enum><header>Authorization of appropriations</header><text display-inline="no-display-inline">There are authorized to be appropriated $50,000,000 for each of fiscal years 2026 through 2030 to carry out this title.</text></section>
</title>
</legis-body>
<endorsement display="yes"><action-date date="20250612">June 12, 2025</action-date><action-desc>Referred to the Committee of the Whole House</action-desc></endorsement>
</bill>
`;

const resolutionXml = (whereasCount: number): string => `<?xml version="1.0"?>
<!DOCTYPE resolution PUBLIC "-//US Congress//DTDs/res.dtd//EN" "res.dtd">
<resolution resolution-stage="Introduced-in-Senate" dms-id="A1" public-private="public" key="H" resolution-type="senate-resolution">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dublinCore><dc:title>119 SRES 999 IS: Designating a day</dc:title></dublinCore></metadata>
<form><congress>119th CONGRESS</congress><session>1st Session</session><legis-num>S. RES. 999</legis-num><current-chamber>IN THE SENATE OF THE UNITED STATES</current-chamber><legis-type>RESOLUTION</legis-type><official-title>Designating June 1, 2025, as <quote>National Rural Water Day</quote>.</official-title></form>
<preamble>
${Array.from({ length: whereasCount }, (_, i) => `<whereas><text>Whereas rural water systems serve community number ${i + 1} and employ local operators who maintain pipes, pumps, and treatment plants every day of the year;</text></whereas>`).join("\n")}
<whereas><text>Whereas it is fitting to recognize these operators: Now, therefore, be it</text></whereas></preamble>
<resolution-body id="S1" style="OLC"><section id="S2" display-inline="yes-display-inline"><text display-inline="yes-display-inline">That the Senate designates June 1, 2025, as <quote>National Rural Water Day</quote> and RESOLVED-SENTINEL encourages the public to learn about local water systems.</text></section></resolution-body>
</resolution>`;

const countOccurrences = (text: string, needle: string): number => text.split(needle).length - 1;

describe("billSummarizer extractBillText (GPO XML)", () => {
  it("returns the official title separately and drops prolog, metadata, form, TOC and endorsement", () => {
    const result = extractBillText(gpoBillXml(2), 1_000_000);

    expect(result.officialTitle).toBe(
      "To provide for rural broadband, water infrastructure, and health care workforce programs, and for other purposes.",
    );
    expect(result.truncated).toBe(false);
    expect(result.fullTextChars).toBe(result.text.length);

    for (const boilerplate of [
      "xml-stylesheet",
      "DOCTYPE",
      "Pursuant to Title 17",
      "U.S. House of Representatives",
      "119th CONGRESS",
      "IN THE HOUSE OF REPRESENTATIVES",
      "A BILL",
      "Ms. Example",
      "Referred to the Committee of the Whole House",
      "Sec. 2. Findings.",
    ]) {
      expect(result.text).not.toContain(boilerplate);
    }
    // The TOC repeats every heading; each must appear once, from the body.
    expect(countOccurrences(result.text, "TITLE I—Rural Broadband")).toBe(1);
    expect(countOccurrences(result.text, "Subtitle A—Grants")).toBe(1);
    expect(result.text).not.toMatch(/<[a-z]/i);
  });

  it("renders headings and body text in document order with entities decoded", () => {
    const { text } = extractBillText(gpoBillXml(2), 1_000_000);

    expect(text.startsWith("Sec. 1. Short title; table of contents")).toBe(true);
    expect(text).toContain("This Act may be cited as the Rural Communities Investment Act of 2025.");
    expect(text).toContain("Sec. 2. Findings\nCongress finds the following: (1) About 22 percent");
    expect(text).toContain("nursing & primary care");
    expect(text).toContain("Sec. 3. Purpose\nThe purpose of this Act is to expand broadband");
    expect(text).toContain("TITLE I—Rural Broadband\nSubtitle A—Grants\nSec. 101. Rural broadband grant program");
    expect(text).toContain("TITLE II—Water Infrastructure\nSec. 201. Lead service line replacement grants");
    expect(text).toContain("TITLE III—Health Care Workforce\nSec. 301. Rural health care workforce loan repayment");
    expect(text.indexOf("TITLE I—")).toBeLessThan(text.indexOf("TITLE II—"));
    expect(text.indexOf("TITLE II—")).toBeLessThan(text.indexOf("TITLE III—"));
  });

  it("keeps amendatory quoted blocks as body text, not as new sections", () => {
    const { text } = extractBillText(gpoBillXml(2), 1_000_000);

    expect(text).toContain(
      "(7 U.S.C. 1926) is amended by adding at the end the following: “310J. Lead pipe grants The Secretary may make grants",
    );
    expect(text).toContain("lead service lines—including the portion on private property.”.");
    expect(text).not.toContain("Sec. 310J");
  });

  it("drops text marked for deletion", () => {
    const { text } = extractBillText(gpoBillXml(2), 1_000_000);

    expect(text).toContain("to deploy broadband service in rural areas.");
    expect(text).not.toContain("that are unserved");
  });

  describe('reported bills (changed="deleted" blocks)', () => {
    const struckSection = (n: number) =>
      `<section id="D${n}" changed="deleted" reported-display-style="strikethrough"><enum>${n}.</enum><header>Struck provision ${n}</header><text>STRUCK-BODY-${n} The Secretary shall carry out the original program number ${n}, which the committee removed from the bill.</text></section>`;
    const substituteSection = (n: number) =>
      `<section id="A${n}" changed="added" reported-display-style="italic"><enum>${n}.</enum><header>Substitute provision ${n}</header><text>ADDED-BODY-${n} The Secretary shall carry out the substitute program number ${n}, as reported by the committee.</text></section>`;

    const reportedBillXml = (sections: number): string => `<?xml version="1.0"?>
<!DOCTYPE bill PUBLIC "-//US Congress//DTDs/bill.dtd//EN" "bill.dtd">
<bill bill-stage="Reported-in-House" public-private="public" key="H" bill-type="olc">
<form><congress>119th CONGRESS</congress><legis-type>A BILL</legis-type><official-title>To establish <deleted-phrase reported-display-style="strikethrough">an old</deleted-phrase><added-phrase reported-display-style="italic">a new</added-phrase> grant program.</official-title></form>
<legis-body id="H1" style="OLC" changed="deleted" reported-display-style="strikethrough">
${Array.from({ length: sections }, (_, i) => struckSection(i + 1)).join("\n")}
<section id="DQ" changed="deleted"><enum>99.</enum><header>Struck amendment</header><text>Section 5 is amended to read as follows:</text>
<quoted-block id="DQB" style="OLC"><section id="DQS"><enum>5.</enum><header>Quoted law</header><text>STRUCK-QUOTED-TEXT</text></section></quoted-block><after-quoted-block>.</after-quoted-block> STRUCK-AFTER-QUOTE</section>
</legis-body>
<legis-body id="H2" style="OLC" changed="added" reported-display-style="italic">
${Array.from({ length: sections }, (_, i) => substituteSection(i + 1)).join("\n")}
<section id="AK" changed="not-changed"><enum>100.</enum><header>Kept provision</header><text>KEPT-TEXT <deleted-phrase>STRUCK-PHRASE</deleted-phrase>stays.</text></section>
</legis-body>
</bill>`;

    it("keeps only the substitute text when the original body is struck", () => {
      const { text, officialTitle } = extractBillText(reportedBillXml(3), 1_000_000);

      expect(text).not.toMatch(/STRUCK-/);
      expect(text).not.toContain("Struck provision");
      for (const n of [1, 2, 3]) {
        expect(text).toContain(`Sec. ${n}. Substitute provision ${n}\nADDED-BODY-${n}`);
      }
      expect(text).toContain("Sec. 100. Kept provision\nKEPT-TEXT stays.");
      expect(officialTitle).toBe("To establish a new grant program.");
    });

    it("spends the budget on the substitute, not on the struck original", () => {
      // With the struck original counted, 60 + 60 sections overflow the default budget and most
      // substitute bodies are cut; without it every substitute body fits.
      const { text, truncated } = extractBillText(reportedBillXml(60));

      expect(truncated).toBe(false);
      expect(text).not.toMatch(/STRUCK-/);
      expect(countOccurrences(text, "ADDED-BODY-")).toBe(60);
    });
  });

  it("fits an omnibus bill in the default budget and still represents its last title", () => {
    const xml = gpoBillXml();
    const result = extractBillText(xml);

    expect(xml.length).toBeGreaterThan(4 * BILL_TEXT_BUDGET_CHARS);
    expect(result.fullTextChars).toBeGreaterThan(3 * BILL_TEXT_BUDGET_CHARS);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(BILL_TEXT_BUDGET_CHARS);

    // Every title is present, and the short tail titles keep their full text.
    expect(result.text).toContain("TITLE I—Rural Broadband");
    expect(result.text).toContain("TITLE II—Water Infrastructure");
    expect(result.text).toContain("TITLE III—Health Care Workforce");
    expect(result.text).toContain("TAIL-SENTINEL-TEXT");
    expect(result.text).toContain("Sec. 302. Authorization of appropriations");
    // Front matter (purpose) survives too.
    expect(result.text).toContain("The purpose of this Act is to expand broadband");

    // The long title is cut: some section headings and body text, then a count of what was left out.
    expect(result.text).toContain("Sec. 101. Rural broadband grant program");
    expect(result.text).toMatch(/\[\d+ more sections not shown\]/);
    expect(result.text).not.toContain(`Broadband grant condition ${LONG_SECTION_COUNT}`);
  });

  it("honours smaller budgets", () => {
    for (const budget of [500, 2_000, 6_000]) {
      const result = extractBillText(gpoBillXml(), budget);
      expect(result.truncated).toBe(true);
      expect(result.text.length).toBeLessThanOrEqual(budget);
      expect(result.text).toContain("TITLE III—Health Care Workforce");
    }
  });

  it("gives a resolution's resolving clause a share of the budget even after a long preamble", () => {
    const result = extractBillText(resolutionXml(80), 3_000);

    expect(result.officialTitle).toBe("Designating June 1, 2025, as National Rural Water Day.");
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(3_000);
    expect(result.text).toContain("Whereas rural water systems serve community number 1");
    expect(result.text).toContain("That the Senate designates June 1, 2025, as National Rural Water Day");
    expect(result.text).not.toContain("IN THE SENATE OF THE UNITED STATES");
  });

  it("treats non-XML input as plain text and empty input as no text", () => {
    expect(extractBillText("An act to rename a post office.", 1_000)).toEqual({
      officialTitle: "",
      text: "An act to rename a post office.",
      fullTextChars: 31,
      truncated: false,
    });
    expect(extractBillText("", 1_000).text).toBe("");
    expect(
      extractBillText(
        "<bill><metadata><dublinCore/></metadata><form><legis-type>A BILL</legis-type></form></bill>",
        1_000,
      ).text,
    ).toBe("");
  });
});

describe("billSummarizer waterFill", () => {
  it("satisfies small items fully and splits the rest evenly", () => {
    expect(waterFill([100, 10_000, 10_000], 3_100)).toEqual([100, 1_500, 1_500]);
    expect(waterFill([10, 20], 1_000)).toEqual([10, 20]);
    expect(waterFill([0, 50], 10)).toEqual([0, 10]);
    expect(waterFill([5, 5], 0)).toEqual([0, 0]);
  });
});
