/**
 * Plain-text extraction for GPO bill XML (bill.dtd and resolution.dtd), used
 * to build the summarizer's model input.
 *
 * This replaces the old "first 4,000 characters of raw XML" snippet, which for
 * large bills was mostly the XML prolog, Dublin Core metadata, the cover-page
 * form and the table of contents. Here those blocks are dropped, the official
 * title is returned separately, and the remaining text is shortened to a
 * character budget that is shared across the bill's top-level divisions or
 * titles, so the tail of an omnibus bill is still represented.
 */

export const BILL_TEXT_BUDGET_CHARS = 16_000;

export interface ExtractedBillText {
  /** Text of <official-title>, or '' when the XML has none. */
  officialTitle: string;
  /** Headings and body text, shortened to the budget. */
  text: string;
  /** Length of the full extracted text before shortening. */
  fullTextChars: number;
  /** True when `text` leaves out part of the full extracted text. */
  truncated: boolean;
}

// Blocks with no bill substance: Dublin Core metadata, the cover-page form
// (congress, session, sponsor and referral line), tables of contents, and the
// back-page endorsement or attestation. Reported versions mark struck text
// either with deleted-block/deleted-phrase elements (dropped here) or, for whole
// blocks such as an amendment in the nature of a substitute, with a
// changed="deleted" attribute on the element (dropped by parseUnits). Dropping
// both leaves the text as amended.
const DELETED_TEXT_ELEMENTS = ["deleted-block", "deleted-phrase"];
const DROPPED_ELEMENTS = [
  "metadata",
  "dublinCore",
  "form",
  "toc",
  "endorsement",
  "attestation",
  ...DELETED_TEXT_ELEMENTS,
];

// changed="deleted" (with reported-display-style="strikethrough") marks a block the committee struck.
const isStruckElement = (attributes: string): boolean =>
  /\bchanged\s*=\s*(["'])deleted\1/.test(attributes) ||
  /\breported-display-style\s*=\s*(["'])strikethrough\1/.test(attributes);

const STRUCTURE_LABELS: Record<string, string> = {
  division: "DIVISION",
  subdivision: "Subdivision",
  title: "TITLE",
  subtitle: "Subtitle",
  part: "PART",
  subpart: "Subpart",
  chapter: "CHAPTER",
  subchapter: "Subchapter",
};

// Containers whose start or end also ends a run of text outside any section,
// so a long preamble cannot crowd out the resolving clause.
const BODY_CONTAINERS = new Set(["preamble", "legis-body", "resolution-body", "engrossed-amendment-body"]);

// Inline elements do not introduce a word break at their boundaries.
const INLINE_ELEMENTS = new Set([
  "quote",
  "short-title",
  "external-xref",
  "internal-xref",
  "term",
  "italic",
  "bold",
  "act-name",
  "committee-name",
  "sponsor",
  "cosponsor",
  "fraction",
  "sup",
  "sub",
  "superscript",
  "subscript",
  "popular-name",
  "after-quoted-block",
]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  mdash: "—",
  ndash: "–",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
  sect: "§",
  para: "¶",
  hellip: "…",
};

/** A body snippet shorter than this is not worth showing. */
const MIN_BODY_CHARS = 60;
/** Target minimum length of each body snippet when many sections compete. */
const BODY_SHARE_TARGET_CHARS = 160;

interface Unit {
  segment: number;
  headers: string[];
  heading: string;
  body: string;
}

interface HeadingParts {
  label: string;
  enumText: string;
  headerText: string;
  done: boolean;
}

interface OpenElement {
  name: string;
  kind: "plain" | "quote" | "struct" | "section" | "enum" | "header";
  parts?: HeadingParts;
  unit?: Unit;
}

const decodeEntities = (value: string): string =>
  value.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[A-Za-z]+);/g, (match, body: string) => {
    if (body.startsWith("#")) {
      const codePoint =
        body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : match;
    }
    return NAMED_ENTITIES[body] ?? match;
  });

const collapseWhitespace = (value: string): string => value.replace(/\s+/g, " ").trim();

const stripNonContent = (xml: string): string =>
  xml
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\?[\s\S]*?\?>/g, " ")
    .replace(/<!DOCTYPE(?:[^[>]|\[[\s\S]*?\])*>/gi, " ")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_match, text: string) =>
      text.replace(/&/g, "&amp;").replace(/</g, "&lt;"),
    );

const removeElements = (xml: string, name: string): string =>
  xml
    .replace(new RegExp(`<${name}(?=[\\s/>])[^>]*/>`, "g"), "")
    .replace(new RegExp(`<${name}(?=[\\s>])[^>]*>[\\s\\S]*?</${name}\\s*>`, "g"), "");

const extractOfficialTitle = (xml: string): string => {
  const match = xml.match(/<official-title(?=[\s>])[^>]*>([\s\S]*?)<\/official-title\s*>/);
  return match ? collapseWhitespace(decodeEntities(match[1].replace(/<[^>]*>/g, ""))) : "";
};

const formatStructureLine = ({ label, enumText, headerText }: HeadingParts): string => {
  const enumValue = collapseWhitespace(enumText);
  const header = collapseWhitespace(headerText);
  if (!enumValue && !header) return "";
  const prefix = enumValue
    ? enumValue.toLowerCase().startsWith(label.toLowerCase())
      ? enumValue
      : `${label} ${enumValue}`
    : label;
  return header ? `${prefix}—${header}` : prefix;
};

const formatSectionHeading = ({ enumText, headerText }: HeadingParts): string => {
  const enumValue = collapseWhitespace(enumText).replace(/\.$/, "");
  const header = collapseWhitespace(headerText);
  if (!enumValue) return header;
  const prefix = /^sec(?:tion)?\b/i.test(enumValue) ? `${enumValue}.` : `Sec. ${enumValue}.`;
  return header ? `${prefix} ${header}` : prefix;
};

/** Splits the bill body into sections (and runs of text outside sections), in document order. */
const parseUnits = (xml: string): Unit[] => {
  const units: Unit[] = [];
  const open: OpenElement[] = [];
  let pendingHeaders: string[] = [];
  let freeUnit: Unit | null = null;
  let quoteDepth = 0;
  let structDepth = 0;
  let segment = 0;
  let needSpace = false;

  const takePendingHeaders = (): string[] => {
    const headers = pendingHeaders;
    pendingHeaders = [];
    return headers;
  };

  const finalizeHeading = (element: OpenElement): void => {
    const parts = element.parts;
    if (!parts || parts.done) return;
    parts.done = true;
    if (element.kind === "struct") {
      const line = formatStructureLine(parts);
      if (line) pendingHeaders.push(line);
    } else if (element.kind === "section" && element.unit) {
      element.unit.heading = formatSectionHeading(parts);
    }
  };

  const finalizeOpenHeadings = (): void => {
    for (const element of open) {
      if (element.kind === "struct" || element.kind === "section") finalizeHeading(element);
    }
  };

  const append = (existing: string, text: string): string => {
    if (!existing) return text;
    if (needSpace && !/[\s“]$/.test(existing) && !/^\s/.test(text)) return `${existing} ${text}`;
    return existing + text;
  };

  const currentUnit = (): Unit => {
    for (let i = open.length - 1; i >= 0; i -= 1) {
      if (open[i].kind === "section" && open[i].unit) return open[i].unit as Unit;
    }
    if (!freeUnit) {
      freeUnit = { segment, headers: takePendingHeaders(), heading: "", body: "" };
      units.push(freeUnit);
    }
    return freeUnit;
  };

  const handleText = (raw: string): void => {
    const text = decodeEntities(raw);
    if (!text.trim()) {
      if (text) needSpace = true;
      return;
    }
    // Heading capture: the innermost enum/header that belongs to an open title or section.
    for (let i = open.length - 1; i >= 0; i -= 1) {
      const element = open[i];
      if ((element.kind === "enum" || element.kind === "header") && element.parts) {
        const field = element.kind === "enum" ? "enumText" : "headerText";
        element.parts[field] = append(element.parts[field], text);
        needSpace = false;
        return;
      }
      if (element.kind === "struct" || element.kind === "section") break;
    }
    finalizeOpenHeadings();
    const unit = currentUnit();
    unit.body = append(unit.body, text);
    needSpace = false;
  };

  const handleOpen = (name: string, selfClosing: boolean): void => {
    if (!INLINE_ELEMENTS.has(name)) needSpace = true;
    if (selfClosing) return;

    const parent = open[open.length - 1];
    const element: OpenElement = { name, kind: "plain" };
    const parentHeadingOpen = Boolean(
      parent && (parent.kind === "struct" || parent.kind === "section") && parent.parts && !parent.parts.done,
    );

    if (name === "quoted-block") {
      // Quoted text (amendments to existing law) is body text, even when it contains
      // sections or titles. Quote marks show the model where it starts and ends.
      if (quoteDepth === 0) {
        finalizeOpenHeadings();
        const unit = currentUnit();
        unit.body = append(unit.body, "“");
        needSpace = false;
      }
      quoteDepth += 1;
      element.kind = "quote";
    } else if (quoteDepth === 0 && STRUCTURE_LABELS[name]) {
      finalizeOpenHeadings();
      if (structDepth === 0) segment += 1;
      structDepth += 1;
      freeUnit = null;
      element.kind = "struct";
      element.parts = { label: STRUCTURE_LABELS[name], enumText: "", headerText: "", done: false };
    } else if (quoteDepth === 0 && name === "section") {
      finalizeOpenHeadings();
      freeUnit = null;
      const unit: Unit = { segment, headers: takePendingHeaders(), heading: "", body: "" };
      units.push(unit);
      element.kind = "section";
      element.unit = unit;
      element.parts = { label: "Sec.", enumText: "", headerText: "", done: false };
    } else if (quoteDepth === 0 && (name === "enum" || name === "header") && parentHeadingOpen) {
      element.kind = name;
      element.parts = parent.parts;
    } else {
      if (quoteDepth === 0 && parentHeadingOpen) finalizeHeading(parent);
      if (quoteDepth === 0 && BODY_CONTAINERS.has(name)) freeUnit = null;
    }

    open.push(element);
  };

  const handleClose = (name: string): void => {
    if (!INLINE_ELEMENTS.has(name)) needSpace = true;
    let index = open.length - 1;
    while (index >= 0 && open[index].name !== name) index -= 1;
    if (index < 0) return;

    const closed = open.splice(index);
    for (let i = closed.length - 1; i >= 0; i -= 1) {
      const element = closed[i];
      if (element.kind === "quote") {
        quoteDepth -= 1;
        if (quoteDepth === 0) {
          const unit = currentUnit();
          unit.body = unit.body.replace(/\s+$/, "") + "”";
          needSpace = false;
        }
      } else if (element.kind === "struct") {
        finalizeHeading(element);
        structDepth -= 1;
        if (structDepth === 0) segment += 1;
        freeUnit = null;
      } else if (element.kind === "section") {
        finalizeHeading(element);
      } else if (quoteDepth === 0 && BODY_CONTAINERS.has(element.name)) {
        freeUnit = null;
      }
    }
  };

  // Names of the elements open inside a struck element, outermost (the struck element) first.
  // Everything inside it is skipped.
  const struck: string[] = [];
  const skipStruckToken = (closing: string, name: string, selfClosing: string): boolean => {
    if (closing) {
      const index = struck.lastIndexOf(name);
      // A close tag for an element opened outside the struck block (malformed XML) ends it.
      if (index < 0) {
        struck.length = 0;
        return false;
      }
      struck.splice(index);
      if (struck.length === 0) needSpace = true;
    } else if (selfClosing !== "/") {
      struck.push(name);
    }
    return true;
  };

  const tokenPattern = /<(\/?)([A-Za-z_][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+)/g;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(xml)) !== null) {
    const [, closing, name, attributes, selfClosing, text] = match;
    if (struck.length > 0) {
      if (text !== undefined || skipStruckToken(closing, name, selfClosing)) continue;
    }
    if (text !== undefined) handleText(text);
    else if (closing) handleClose(name);
    else if (selfClosing !== "/" && isStruckElement(attributes)) {
      needSpace = true;
      struck.push(name);
    } else handleOpen(name, selfClosing === "/");
  }

  finalizeOpenHeadings();
  if (pendingHeaders.length > 0) {
    units.push({ segment, headers: takePendingHeaders(), heading: "", body: "" });
  }

  for (const unit of units) {
    unit.heading = collapseWhitespace(unit.heading);
    unit.body = collapseWhitespace(unit.body);
  }
  return units.filter((unit) => unit.headers.length > 0 || unit.heading || unit.body);
};

const unitText = (unit: Unit): string => [...unit.headers, unit.heading, unit.body].filter(Boolean).join("\n");

const renderUnits = (units: Unit[]): string => units.map(unitText).filter(Boolean).join("\n");

/**
 * Splits `budget` across items so that no item gets more than it needs and the
 * rest share equally (water filling). Returns whole-character allocations.
 */
export const waterFill = (lengths: readonly number[], budget: number): number[] => {
  const allocations = lengths.map(() => 0);
  let remaining = Math.max(0, Math.floor(budget));
  let open = lengths.map((_, index) => index).filter((index) => lengths[index] > 0);

  while (open.length > 0 && remaining > 0) {
    const share = Math.floor(remaining / open.length);
    if (share === 0) break;
    const stillOpen: number[] = [];
    for (const index of open) {
      const give = Math.min(lengths[index] - allocations[index], share);
      allocations[index] += give;
      remaining -= give;
      if (allocations[index] < lengths[index]) stillOpen.push(index);
    }
    open = stillOpen;
  }
  return allocations;
};

const truncateText = (text: string, maxChars: number): string => {
  if (text.length <= maxChars) return text;
  if (maxChars < MIN_BODY_CHARS) return "";
  const cut = text.slice(0, maxChars - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
};

/**
 * Renders one segment (a top-level division or title, or the text before the
 * first one) within `allowance` characters. Priority: structural headings
 * (title, subtitle, part), then section headings in order (at most half of
 * what is left when there is body text), then body text shared across the
 * first sections shown.
 */
const renderSegmentWithin = (units: Unit[], allowance: number): string => {
  const lineCost = (line: string): number => line.length + 1;
  let remaining = allowance;

  const headerKeep = units.map(() => [] as string[]);
  let headersFull = false;
  for (let i = 0; i < units.length && !headersFull; i += 1) {
    for (const header of units[i].headers) {
      if (lineCost(header) > remaining) {
        headersFull = true;
        break;
      }
      headerKeep[i].push(header);
      remaining -= lineCost(header);
    }
  }

  const hasBody = units.some((unit) => unit.body);
  let headingBudget = hasBody ? Math.floor(remaining / 2) : remaining;
  const shown = units.map(() => false);
  let omitted = 0;
  for (let i = 0; i < units.length; i += 1) {
    const heading = units[i].heading;
    if (!heading) {
      shown[i] = omitted === 0;
      continue;
    }
    if (omitted === 0 && lineCost(heading) <= headingBudget) {
      shown[i] = true;
      headingBudget -= lineCost(heading);
      remaining -= lineCost(heading);
    } else {
      omitted += 1;
    }
  }

  const marker = omitted > 0 ? `[${omitted} more section${omitted === 1 ? "" : "s"} not shown]` : "";
  if (marker) remaining -= lineCost(marker);

  const bodyCandidates = units
    .map((unit, index) => (shown[index] && unit.body ? index : -1))
    .filter((index) => index >= 0);
  const bodyCount = Math.min(
    bodyCandidates.length,
    Math.max(1, Math.floor(Math.max(0, remaining) / BODY_SHARE_TARGET_CHARS)),
  );
  const bodyIndexes = bodyCandidates.slice(0, bodyCount);
  const bodyAllocations = waterFill(
    bodyIndexes.map((index) => lineCost(units[index].body)),
    remaining,
  );
  const bodies = new Map<number, string>();
  bodyIndexes.forEach((unitIndex, k) => {
    const body = truncateText(units[unitIndex].body, bodyAllocations[k] - 1);
    if (body) bodies.set(unitIndex, body);
  });

  const lines: string[] = [];
  units.forEach((unit, index) => {
    lines.push(...headerKeep[index]);
    if (!shown[index]) return;
    if (unit.heading) lines.push(unit.heading);
    const body = bodies.get(index);
    if (body) lines.push(body);
  });
  if (marker) lines.push(marker);

  const rendered = lines.join("\n");
  return rendered.length <= allowance ? rendered : rendered.slice(0, allowance);
};

/**
 * Extracts readable text from GPO bill XML and shortens it to `budgetChars`.
 * Input that is not XML is treated as plain text.
 */
export const extractBillText = (xml: string, budgetChars: number = BILL_TEXT_BUDGET_CHARS): ExtractedBillText => {
  const cleaned = stripNonContent(xml ?? "");
  // The title sits inside <form>, which is dropped below, so it is read first (without struck phrases).
  const officialTitle = extractOfficialTitle(DELETED_TEXT_ELEMENTS.reduce(removeElements, cleaned));
  const body = DROPPED_ELEMENTS.reduce(removeElements, cleaned);
  const units = parseUnits(body);

  const full = renderUnits(units);
  const budget = Math.max(0, Math.floor(budgetChars));
  if (full.length <= budget) {
    return { officialTitle, text: full, fullTextChars: full.length, truncated: false };
  }

  const segments: Unit[][] = [];
  let lastSegment: number | null = null;
  for (const unit of units) {
    if (unit.segment !== lastSegment) {
      segments.push([]);
      lastSegment = unit.segment;
    }
    segments[segments.length - 1].push(unit);
  }

  const segmentTexts = segments.map(renderUnits);
  const allocations = waterFill(
    segmentTexts.map((text) => text.length),
    budget - Math.max(0, segments.length - 1),
  );
  const text = segments
    .map((segmentUnits, index) =>
      segmentTexts[index].length <= allocations[index]
        ? segmentTexts[index]
        : renderSegmentWithin(segmentUnits, allocations[index]),
    )
    .filter(Boolean)
    .join("\n");

  return { officialTitle, text, fullTextChars: full.length, truncated: true };
};
