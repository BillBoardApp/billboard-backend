import type { AttributeValue } from "@aws-sdk/client-dynamodb";

type Row = Record<string, AttributeValue>;

export interface SetUpdateInput {
  Key: Row;
  UpdateExpression?: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, AttributeValue>;
}

const ASSIGNMENT = /^(#\w+) = (?:if_not_exists\((#\w+), (:\w+)\)|(:\w+))$/;

/**
 * The row an UpdateItem leaves, as DynamoDB would write it: `row` (undefined for a row that does not exist yet, which
 * UpdateItem creates) with the input's key and its SET assignments applied. Only the two forms the device writers use
 * are read, `#a = :v` and `#a = if_not_exists(#a, :v)`; anything else throws, so a test notices a new form. As
 * DynamoDB does, it also refuses a placeholder that is passed but unused, or used but not passed.
 */
export function applySetUpdate(row: Row | undefined, input: SetUpdateInput): Row {
  const expression = String(input.UpdateExpression ?? "");
  if (!expression.startsWith("SET ")) throw new Error(`Unsupported update: ${expression}`);
  const names = input.ExpressionAttributeNames ?? {};
  const values = input.ExpressionAttributeValues ?? {};
  const usedNames = new Set<string>();
  const usedValues = new Set<string>();
  const name = (placeholder: string): string => {
    const attribute = names[placeholder];
    if (attribute === undefined) throw new Error(`Name ${placeholder} is used but not passed`);
    usedNames.add(placeholder);
    return attribute;
  };
  const value = (placeholder: string): AttributeValue => {
    const attributeValue = values[placeholder];
    if (attributeValue === undefined) throw new Error(`Value ${placeholder} is used but not passed`);
    usedValues.add(placeholder);
    return attributeValue;
  };

  const next: Row = { ...(row ?? {}), ...input.Key };
  // Split on the commas between assignments, not the one inside if_not_exists(...).
  for (const assignment of expression.slice("SET ".length).split(/,\s*(?![^(]*\))/)) {
    const match = ASSIGNMENT.exec(assignment.trim());
    if (!match) throw new Error(`Unsupported assignment: ${assignment}`);
    const [, target, existsName, fallback, plain] = match;
    const attribute = name(target);
    if (plain) {
      next[attribute] = value(plain);
      continue;
    }
    if (name(existsName) !== attribute) throw new Error(`if_not_exists names another attribute: ${assignment}`);
    // if_not_exists reads the row as it was before this update.
    const fallbackValue = value(fallback);
    next[attribute] = row?.[attribute] ?? fallbackValue;
  }

  const unusedNames = Object.keys(names).filter((placeholder) => !usedNames.has(placeholder));
  const unusedValues = Object.keys(values).filter((placeholder) => !usedValues.has(placeholder));
  if (unusedNames.length > 0 || unusedValues.length > 0) {
    throw new Error(`Unused placeholders: ${[...unusedNames, ...unusedValues].join(", ")}`);
  }
  return next;
}
