import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { conditionalCheckFailed, evaluateCondition } from "./fixtures/dynamoCondition";

// The test-only evaluator the in-memory table mocks use; wrong answers here would make those tests lie.
describe("evaluateCondition (test fixture)", () => {
  const names = { "#a": "a", "#set": "tags", "#list": "items", "#text": "title" };
  const values = {
    ":one": { N: "1" },
    ":two": { N: "2" },
    ":x": { S: "x" },
    ":prefix": { S: "Hea" },
    ":item": { S: "i2" },
    ":num": { N: "7" },
  };
  const check = (item: Record<string, AttributeValue> | undefined, expression: string) =>
    evaluateCondition(item, {
      ConditionExpression: expression,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    });

  it("passes without an expression", () => {
    expect(evaluateCondition(undefined, undefined)).toBe(true);
    expect(evaluateCondition({}, {})).toBe(true);
  });

  it("compares numbers numerically and strings lexicographically", () => {
    expect(check({ a: { N: "1.0" } }, "#a = :one")).toBe(true);
    expect(check({ a: { N: "1" } }, "#a <> :two")).toBe(true);
    expect(check({ a: { N: "1" } }, "#a < :two AND #a <= :one AND NOT #a > :one AND #a >= :one")).toBe(true);
    expect(check({ a: { S: "w" } }, "#a < :x")).toBe(true);
    expect(check({ a: { S: "w" } }, "#a < :one")).toBe(false);
  });

  it("treats a missing attribute as failing every comparison", () => {
    expect(check({}, "#a = :one")).toBe(false);
    expect(check({}, "#a <> :one")).toBe(false);
    expect(check({}, "#a < :one")).toBe(false);
  });

  it("supports existence checks, contains, begins_with, precedence and parentheses", () => {
    const item = {
      tags: { SS: ["x"] },
      items: { L: [{ S: "i1" }, { S: "i2" }] },
      title: { S: "Health" },
      nums: { NS: ["7"] },
    };
    expect(check(item, "attribute_exists(#set) AND attribute_not_exists(#a)")).toBe(true);
    expect(check(item, "contains(#set, :x) AND contains(#list, :item) AND contains(#text, :prefix)")).toBe(true);
    expect(check(item, "contains(nums, :num) AND begins_with(#text, :prefix)")).toBe(true);
    expect(check(item, "contains(#a, :x)")).toBe(false);
    // AND binds tighter than OR.
    expect(check(item, "attribute_exists(#a) AND attribute_exists(#a) OR attribute_exists(#set)")).toBe(true);
    expect(check(item, "attribute_exists(#a) AND (attribute_exists(#a) OR attribute_exists(#set))")).toBe(false);
    expect(check(undefined, "NOT contains(#set, :x) AND attribute_not_exists(#set)")).toBe(true);
  });

  it("walks map paths: each part a #name or a plain name", () => {
    const item = { holders: { M: { "user-1": { S: "2026-10-01T00:00:00.000Z" } } }, a: { N: "1" } };
    const inMap = (holder: string) =>
      evaluateCondition(item, {
        ConditionExpression: "attribute_exists(#holders.#holder)",
        ExpressionAttributeNames: { "#holders": "holders", "#holder": holder },
      });
    expect(inMap("user-1")).toBe(true);
    expect(inMap("user-2")).toBe(false);
    expect(
      evaluateCondition(undefined, {
        ConditionExpression: "attribute_not_exists(holders.#holder)",
        ExpressionAttributeNames: { "#holder": "user-1" },
      }),
    ).toBe(true);
    // A path through an attribute that is not a map names nothing.
    expect(check(item, "attribute_exists(#a.#text)")).toBe(false);
    expect(
      evaluateCondition(item, {
        ConditionExpression: "holders.#holder = :at",
        ExpressionAttributeNames: { "#holder": "user-1" },
        ExpressionAttributeValues: { ":at": { S: "2026-10-01T00:00:00.000Z" } },
      }),
    ).toBe(true);
  });

  it("rejects expressions it does not understand instead of guessing", () => {
    expect(() => check({}, "size(#a) > :one")).toThrow();
    expect(() => check({}, "#missing = :one")).toThrow("Undefined attribute name");
    expect(() => check({}, "#a = :missing")).toThrow("Undefined attribute value");
    expect(() => check({}, "#a = :one )")).toThrow("Unparsed tokens");
    expect(() => check({}, "#a :one")).toThrow("Expected a comparator");
    expect(() => check({}, "attribute_exists(:one)")).toThrow("Expected an attribute");
    expect(() => check({}, "attribute_exists(#a")).toThrow("Unexpected end");
    expect(() => check({}, "#a = :one ; x")).toThrow("Unsupported character");
  });

  it("builds the ConditionalCheckFailedException DynamoDB throws, with the old item when asked", () => {
    expect(conditionalCheckFailed()).toMatchObject({ name: "ConditionalCheckFailedException" });
    expect(conditionalCheckFailed()).not.toHaveProperty("Item");
    expect(conditionalCheckFailed({ a: { N: "1" } }).Item).toEqual({ a: { N: "1" } });
  });
});
