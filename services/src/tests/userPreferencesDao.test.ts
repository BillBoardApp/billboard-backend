import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { UserPreferencesDao } from "../adapters/userPreferencesDao";

type QueryCommandInput = {
  [key: string]: unknown;
};

const mockSend = jest.fn();

jest.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: jest.fn(),
  QueryCommand: jest.fn().mockImplementation((input: QueryCommandInput) => ({ input })),
  BatchGetItemCommand: jest.fn().mockImplementation((input: QueryCommandInput) => ({ input })),
}));

describe("UserPreferencesDao", () => {
  const dynamo = { send: mockSend } as unknown as DynamoDBClient;

  const baseConfig = {
    tableName: "UserPreferences",
    userIdAttribute: "userId",
    subCategoryAttribute: "subCategory",
    subCategoryIndexName: "GSI_SubCategory",
    categoryAttribute: "category",
    categoryIndexName: "GSI_Category",
  } as const;

  beforeEach(() => {
    mockSend.mockReset();
  });

  it("queries the sub-category index and returns distinct user ids", async () => {
    mockSend
      .mockResolvedValueOnce({
        Items: [{ userId: { S: "user-1" } }, { userId: { S: "user-2" } }],
        LastEvaluatedKey: { userId: { S: "user-2" } },
      })
      .mockResolvedValueOnce({
        Items: [{ userId: { S: "user-2" } }, { userId: { S: "user-3" } }],
      });

    const dao = new UserPreferencesDao(dynamo, baseConfig);

    const users = await dao.getUsersForSubCategory("Healthcare");

    expect(mockSend).toHaveBeenCalledTimes(2);
    const firstQuery = mockSend.mock.calls[0][0].input;
    expect(firstQuery.IndexName).toBe("GSI_SubCategory");
    expect(firstQuery.KeyConditionExpression).toBe("#sub = :sub");
    expect(users.sort()).toEqual(["user-1", "user-2", "user-3"]);
  });

  it("adds a type filter when requested", async () => {
    mockSend
      .mockResolvedValueOnce({
        Items: [{ userId: { S: "user-1" } }, { userId: { S: "user-2" } }],
      })
      .mockResolvedValueOnce({
        Responses: {
          UserPreferences: [
            { userId: { S: "user-1" }, preference: { S: "Healthcare" }, type: { S: "Category" } },
            { userId: { S: "user-2" }, preference: { S: "Healthcare" }, type: { S: "Life Area" } },
          ],
        },
      });

    const dao = new UserPreferencesDao(dynamo, baseConfig);

    const users = await dao.getUsersForSubCategory("Healthcare", "Category");

    expect(mockSend).toHaveBeenCalledTimes(2);
    const query = mockSend.mock.calls[0][0].input;
    expect(query.IndexName).toBe("GSI_SubCategory");
    expect(query.KeyConditionExpression).toBe("#sub = :sub");
    expect(query.ExpressionAttributeValues).toEqual({
      ":sub": { S: "Healthcare" },
    });

    const batchGet = mockSend.mock.calls[1][0].input;
    expect(batchGet.RequestItems.UserPreferences.Keys).toEqual([
      { userId: { S: "user-1" }, subCategory: { S: "Healthcare" } },
      { userId: { S: "user-2" }, subCategory: { S: "Healthcare" } },
    ]);

    expect(users).toEqual(["user-1"]);
  });

  it("filters by any of several types when given a list", async () => {
    mockSend
      .mockResolvedValueOnce({
        Items: [{ userId: { S: "user-1" } }, { userId: { S: "user-2" } }, { userId: { S: "user-3" } }],
      })
      .mockResolvedValueOnce({
        Responses: {
          UserPreferences: [
            { userId: { S: "user-1" }, subCategory: { S: "BILLS-119hr1" }, type: { S: "Bill" } },
            { userId: { S: "user-2" }, subCategory: { S: "BILLS-119hr1" }, type: { S: "Watch" } },
            { userId: { S: "user-3" }, subCategory: { S: "BILLS-119hr1" }, type: { S: "Category" } },
          ],
        },
      });

    const dao = new UserPreferencesDao(dynamo, baseConfig);

    expect(await dao.getUsersForSubCategory("BILLS-119hr1", ["Bill", "Watch"])).toEqual(["user-1", "user-2"]);
  });

  it("queries the base table for user preferences", async () => {
    mockSend.mockResolvedValueOnce({
      Items: [{ userId: { S: "user-1" }, subCategory: { S: "Healthcare" } }],
    });

    const dao = new UserPreferencesDao(dynamo, baseConfig);

    const preferences = await dao.getUserPreferences("user-1");

    expect(mockSend).toHaveBeenCalledTimes(1);
    const query = mockSend.mock.calls[0][0].input;
    expect(query.IndexName).toBeUndefined();
    expect(query.KeyConditionExpression).toBe("#uid = :uid");
    expect(preferences).toHaveLength(1);
    expect(preferences[0]).toMatchObject({
      userId: { S: "user-1" },
      subCategory: { S: "Healthcare" },
    });
  });

  it("queries the category index when category information is requested", async () => {
    mockSend.mockResolvedValueOnce({
      Items: [{ userId: { S: "user-4" } }],
    });

    const dao = new UserPreferencesDao(dynamo, baseConfig);

    const users = await dao.getUsersForCategory("Social Policy", "Healthcare");

    expect(mockSend).toHaveBeenCalledTimes(1);
    const query = mockSend.mock.calls[0][0].input;
    expect(query.IndexName).toBe("GSI_Category");
    expect(query.KeyConditionExpression).toBe("#cat = :cat AND #sub = :sub");
    expect(users).toEqual(["user-4"]);
  });

  it("throws if sub-category lookup is requested without index config", async () => {
    const dao = new UserPreferencesDao(dynamo, {
      tableName: "UserPreferences",
      userIdAttribute: "userId",
    });

    await expect(dao.getUsersForSubCategory("Healthcare")).rejects.toThrow(/no index configuration provided/i);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("throws if category lookup is requested without category attribute", async () => {
    const dao = new UserPreferencesDao(dynamo, {
      tableName: "UserPreferences",
      userIdAttribute: "userId",
      subCategoryAttribute: "subCategory",
      subCategoryIndexName: "GSI_SubCategory",
    });

    await expect(dao.getUsersForCategory("Social Policy")).rejects.toThrow(/category attribute is not configured/i);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("throws if sub-category filter is provided without attribute configuration", async () => {
    const dao = new UserPreferencesDao(dynamo, {
      tableName: "UserPreferences",
      userIdAttribute: "userId",
      categoryAttribute: "category",
      categoryIndexName: "GSI_Category",
    });

    await expect(dao.getUsersForCategory("Social Policy", "Healthcare")).rejects.toThrow(
      /sub-category attribute is not configured/i,
    );
    expect(mockSend).not.toHaveBeenCalled();
  });
});

export {};
