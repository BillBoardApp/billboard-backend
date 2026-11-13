/**
 * Words and phrases that signal editorial or partisan framing, as found in a
 * review of production summaries. One list serves three checks: the summarizer system prompt
 * must contain none of them (unit test), the priority resolver replaces a
 * model-written reason that uses one, and scripts/evalSummaries.ts counts
 * them in model output.
 */
export const LOADED_WORDS = [
  "power grab",
  "radical",
  "extreme",
  "far-left",
  "far-right",
  "socialist",
  "woke",
  "MAGA",
  "common-sense",
  "reckless",
  "dangerous",
  "crackdown",
  "handout",
  "giveaway",
  "loophole",
  "bloated",
  "big government",
  "job-killing",
  "tax-and-spend",
  "pro-life",
  "pro-abortion",
  "anti-immigrant",
  "open borders",
  "illegal alien",
  "amnesty",
  "assault on",
  "attack on",
  "finally",
  "forever",
  "in stone",
  "secretly",
  "cover up",
] as const;

export type LoadedWord = (typeof LOADED_WORDS)[number];

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Whole-word, case-insensitive. A space or hyphen in a phrase also matches the
// other separator or none ("common sense", "commonsense"), and a plural "s"/"es"
// is allowed ("handouts", "loopholes").
const LOADED_WORD_PATTERNS: ReadonlyArray<{ word: LoadedWord; pattern: RegExp }> = LOADED_WORDS.map((word) => ({
  word,
  pattern: new RegExp(
    `\\b${word
      .split(/[\s-]+/)
      .map(escapeRegExp)
      .join("[\\s-]?")}(?:s|es)?\\b`,
    "gi",
  ),
}));

/**
 * Returns one entry per loaded-word occurrence in `text`, in list order
 * (so `findLoadedWords(text).length` is the hit count).
 */
export const findLoadedWords = (text: string): LoadedWord[] => {
  if (!text) return [];
  const hits: LoadedWord[] = [];
  for (const { word, pattern } of LOADED_WORD_PATTERNS) {
    const matches = text.match(pattern);
    if (matches) {
      for (let i = 0; i < matches.length; i += 1) hits.push(word);
    }
  }
  return hits;
};
