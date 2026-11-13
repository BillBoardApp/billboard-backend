import type { AttributeValue } from "@aws-sdk/client-dynamodb";

/**
 * Evaluates a DynamoDB ConditionExpression against an item held as AttributeValues, so in-memory
 * table mocks honour the exact expression a handler sends instead of re-implementing its intent.
 *
 * Supported: OR, AND, NOT, parentheses, attribute_exists, attribute_not_exists, contains,
 * begins_with and the comparators = <> < <= > >= between #names, :values and plain attribute
 * names, and map paths of them (`#holders.#holder`: each part a #name or a plain name, walked through
 * maps). Numbers compare numerically, strings lexicographically. An absent attribute makes every
 * comparison false, as in DynamoDB.
 */

type Item = Record<string, AttributeValue> | undefined | null;

export interface ConditionInput {
  ConditionExpression?: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, AttributeValue>;
}

const COMPARATORS = ["<=", ">=", "<>", "=", "<", ">"] as const;
type Comparator = (typeof COMPARATORS)[number];

const tokenize = (expression: string): string[] => {
  const tokens: string[] = [];
  let index = 0;
  while (index < expression.length) {
    const char = expression[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === "(" || char === ")" || char === ",") {
      tokens.push(char);
      index += 1;
      continue;
    }
    const comparator = COMPARATORS.find((candidate) => expression.startsWith(candidate, index));
    if (comparator) {
      tokens.push(comparator);
      index += comparator.length;
      continue;
    }
    const match = /^[#:]?[A-Za-z0-9_]+(?:\.#?[A-Za-z0-9_]+)*/.exec(expression.slice(index));
    if (!match) throw new Error(`Unsupported character in condition: ${expression.slice(index)}`);
    tokens.push(match[0]);
    index += match[0].length;
  }
  return tokens;
};

const isEqual = (left: AttributeValue | undefined, right: AttributeValue | undefined): boolean => {
  if (left === undefined || right === undefined) return false;
  if (left.N !== undefined && right.N !== undefined) return Number(left.N) === Number(right.N);
  return JSON.stringify(left) === JSON.stringify(right);
};

const compare = (left: AttributeValue | undefined, op: Comparator, right: AttributeValue | undefined): boolean => {
  if (op === "=") return isEqual(left, right);
  if (left === undefined || right === undefined) return false;
  if (op === "<>") return !isEqual(left, right);
  let difference: number;
  if (left.N !== undefined && right.N !== undefined) difference = Number(left.N) - Number(right.N);
  else if (left.S !== undefined && right.S !== undefined) difference = left.S < right.S ? -1 : left.S > right.S ? 1 : 0;
  else return false;
  if (op === "<") return difference < 0;
  if (op === "<=") return difference <= 0;
  if (op === ">") return difference > 0;
  return difference >= 0;
};

const containsValue = (attribute: AttributeValue | undefined, operand: AttributeValue | undefined): boolean => {
  if (!attribute || !operand) return false;
  if (attribute.SS && operand.S !== undefined) return attribute.SS.includes(operand.S);
  if (attribute.NS && operand.N !== undefined) return attribute.NS.some((value) => Number(value) === Number(operand.N));
  if (attribute.S !== undefined && operand.S !== undefined) return attribute.S.includes(operand.S);
  if (attribute.L) return attribute.L.some((value) => isEqual(value, operand));
  return false;
};

export const evaluateCondition = (item: Item, input: ConditionInput | undefined): boolean => {
  const expression = input?.ConditionExpression;
  if (!expression) return true;
  const names = input?.ExpressionAttributeNames ?? {};
  const values = input?.ExpressionAttributeValues ?? {};
  const tokens = tokenize(expression);
  let position = 0;

  const peek = (): string | undefined => tokens[position];
  const next = (): string => {
    const token = tokens[position];
    if (token === undefined) throw new Error(`Unexpected end of condition: ${expression}`);
    position += 1;
    return token;
  };
  const expect = (token: string): void => {
    const actual = next();
    if (actual !== token) throw new Error(`Expected "${token}" but found "${actual}" in: ${expression}`);
  };
  const attributeName = (token: string): string => {
    if (token.startsWith("#")) {
      const name = names[token];
      if (name === undefined) throw new Error(`Undefined attribute name ${token} in: ${expression}`);
      return name;
    }
    if (token.startsWith(":")) throw new Error(`Expected an attribute, found ${token} in: ${expression}`);
    return token;
  };
  /** The attribute a path names: its first part on the item, each further part inside the map before it. */
  const attributeAt = (token: string): AttributeValue | undefined => {
    const [first, ...rest] = token.split(".").map(attributeName);
    let value = item?.[first];
    for (const part of rest) value = value?.M?.[part];
    return value;
  };
  const operand = (token: string): AttributeValue | undefined => {
    if (token.startsWith(":")) {
      if (!(token in values)) throw new Error(`Undefined attribute value ${token} in: ${expression}`);
      return values[token];
    }
    return attributeAt(token);
  };

  const parseOr = (): boolean => {
    let result = parseAnd();
    while (peek()?.toUpperCase() === "OR") {
      next();
      const right = parseAnd();
      result = result || right;
    }
    return result;
  };
  const parseAnd = (): boolean => {
    let result = parseNot();
    while (peek()?.toUpperCase() === "AND") {
      next();
      const right = parseNot();
      result = result && right;
    }
    return result;
  };
  const parseNot = (): boolean => {
    if (peek()?.toUpperCase() === "NOT") {
      next();
      return !parseNot();
    }
    return parsePrimary();
  };
  const parsePrimary = (): boolean => {
    const token = next();
    if (token === "(") {
      const result = parseOr();
      expect(")");
      return result;
    }
    const lowered = token.toLowerCase();
    if (lowered === "attribute_exists" || lowered === "attribute_not_exists") {
      expect("(");
      const exists = attributeAt(next()) !== undefined;
      expect(")");
      return lowered === "attribute_exists" ? exists : !exists;
    }
    if (lowered === "contains" || lowered === "begins_with") {
      expect("(");
      // Read the token before indexing: `item?.[next()]` would skip it when there is no item.
      const attribute = attributeAt(next());
      expect(",");
      const value = operand(next());
      expect(")");
      if (lowered === "contains") return containsValue(attribute, value);
      return attribute?.S !== undefined && value?.S !== undefined && attribute.S.startsWith(value.S);
    }
    const left = operand(token);
    const op = next();
    if (!COMPARATORS.includes(op as Comparator))
      throw new Error(`Expected a comparator, found "${op}" in: ${expression}`);
    return compare(left, op as Comparator, operand(next()));
  };

  const result = parseOr();
  if (position !== tokens.length) throw new Error(`Unparsed tokens in condition: ${expression}`);
  return result;
};

/** The error DynamoDB throws when a condition fails; `item` is attached as ReturnValuesOnConditionCheckFailure ALL_OLD would. */
export const conditionalCheckFailed = (item?: Record<string, AttributeValue>) =>
  Object.assign(new Error("The conditional request failed"), {
    name: "ConditionalCheckFailedException",
    ...(item ? { Item: item } : {}),
  });
