import { Match } from "aws-cdk-lib/assertions";
import { synthesizeStacks } from "./helpers/synth-stacks";

const templates = synthesizeStacks();

describe("UserStoreStack", () => {
  test("indexes user devices by push token so registration never scans the table", () => {
    templates.userStoreTemplate.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "UserDevices",
      GlobalSecondaryIndexes: [
        {
          IndexName: "GSIPushTokenIndex",
          KeySchema: [{ AttributeName: "pushToken", KeyType: "HASH" }],
          Projection: { ProjectionType: "KEYS_ONLY" },
        },
      ],
    });
  });

  test("protects every user table with deletion protection, PITR and RETAIN", () => {
    templates.userStoreTemplate.allResourcesProperties("AWS::DynamoDB::Table", {
      DeletionProtectionEnabled: true,
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    });
    templates.userStoreTemplate.allResources("AWS::DynamoDB::Table", {
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
    });
  });

  test("expires weekly digests through a TTL on the ttl attribute", () => {
    templates.userStoreTemplate.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "UserWeeklyDigests",
      TimeToLiveSpecification: { AttributeName: "ttl", Enabled: true },
    });
  });

  test("leaves the feedback bill-id index projection unchanged (changing it recreates the index)", () => {
    templates.userStoreTemplate.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "UserFeedback",
      GlobalSecondaryIndexes: [
        Match.objectLike({
          IndexName: "GSIBillIdIndex",
          Projection: { ProjectionType: "ALL" },
        }),
      ],
    });
  });

  test("provisions the user data tables with the expected names", () => {
    templates.userStoreTemplate.resourceCountIs("AWS::DynamoDB::Table", 9);

    [
      "UserPreferences",
      "UserDevices",
      "UserFeedback",
      "UserPII",
      "BillStats",
      "UserWeeklyDigests",
      "VerifiedAddressClaims",
      "SignUpEmailClaims",
      "AppAttest",
    ].forEach((tableName) => {
      templates.userStoreTemplate.hasResourceProperties("AWS::DynamoDB::Table", {
        TableName: tableName,
      });
    });

    templates.userStoreTemplate.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "UserWeeklyDigests",
      KeySchema: [
        {
          AttributeName: "userId",
          KeyType: "HASH",
        },
        {
          AttributeName: "publishedAt",
          KeyType: "RANGE",
        },
      ],
    });
  });

  // The account-integrity tables are new (no replacement of an existing one) and keyed exactly as the services read
  // them. The claim tables hold only salted hashes: no stream, TTL or index, nothing for another reader to follow.
  describe("account-integrity tables", () => {
    const tableNamed = (tableName: string) => {
      const matches = Object.entries(templates.userStoreTemplate.findResources("AWS::DynamoDB::Table", {
        Properties: { TableName: tableName },
      }));
      expect(matches).toHaveLength(1);
      return { logicalId: matches[0][0], resource: matches[0][1] };
    };

    test("VerifiedAddressClaims (INT-03) is keyed claimKey + member, on demand, protected and plain", () => {
      const { logicalId, resource } = tableNamed("VerifiedAddressClaims");
      expect(logicalId).toMatch(/^VerifiedAddressClaimsTable[0-9A-F]{8}$/);
      expect(resource.DeletionPolicy).toBe("Retain");
      expect(resource.UpdateReplacePolicy).toBe("Retain");
      expect(resource.Properties).toEqual({
        TableName: "VerifiedAddressClaims",
        KeySchema: [
          { AttributeName: "claimKey", KeyType: "HASH" },
          { AttributeName: "member", KeyType: "RANGE" },
        ],
        AttributeDefinitions: [
          { AttributeName: "claimKey", AttributeType: "S" },
          { AttributeName: "member", AttributeType: "S" },
        ],
        BillingMode: "PAY_PER_REQUEST",
        DeletionProtectionEnabled: true,
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      });
    });

    // X5: two items per claim (EMAIL#<emailKey> and USER#<userName>) under one partition key named pk, not
    // emailKey, so account deletion can find a user's claim by USER#<userName>.
    test("SignUpEmailClaims (INT-05) is keyed pk only, on demand, protected and plain", () => {
      const { logicalId, resource } = tableNamed("SignUpEmailClaims");
      expect(logicalId).toMatch(/^SignUpEmailClaimsTable[0-9A-F]{8}$/);
      expect(resource.DeletionPolicy).toBe("Retain");
      expect(resource.UpdateReplacePolicy).toBe("Retain");
      expect(resource.Properties).toEqual({
        TableName: "SignUpEmailClaims",
        KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
        AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }],
        BillingMode: "PAY_PER_REQUEST",
        DeletionProtectionEnabled: true,
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      });
    });

    // INT-04 (C3 4.1): challenges, attested keys and account bindings under pk/sk. The TTL removes used and
    // expired challenges, and keys and bindings APP_ATTEST_KEY_TTL_SECONDS (services/src/shared/abuseLimits.ts) after
    // their last use.
    test("AppAttest (INT-04) is keyed pk + sk, on demand, protected, with a ttl TTL and no stream or index", () => {
      const { logicalId, resource } = tableNamed("AppAttest");
      expect(logicalId).toMatch(/^AppAttestTable[0-9A-F]{8}$/);
      expect(resource.DeletionPolicy).toBe("Retain");
      expect(resource.UpdateReplacePolicy).toBe("Retain");
      expect(resource.Properties).toEqual({
        TableName: "AppAttest",
        KeySchema: [
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
        AttributeDefinitions: [
          { AttributeName: "pk", AttributeType: "S" },
          { AttributeName: "sk", AttributeType: "S" },
        ],
        BillingMode: "PAY_PER_REQUEST",
        DeletionProtectionEnabled: true,
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
        TimeToLiveSpecification: { AttributeName: "ttl", Enabled: true },
      });
    });

    test("the six existing tables keep their logical IDs (the new tables replace nothing)", () => {
      const ids = Object.keys(templates.userStoreTemplate.findResources("AWS::DynamoDB::Table"))
        .map((logicalId) => logicalId.replace(/[0-9A-F]{8}$/, ""))
        .sort();
      expect(ids).toEqual([
        "AppAttestTable",
        "BillStatsTable",
        "DevicesTable",
        "PIITable",
        "SignUpEmailClaimsTable",
        "UserFeedbackTable",
        "UserPreferencesTable",
        "UserWeeklyDigestsTable",
        "VerifiedAddressClaimsTable",
      ]);
    });

    test("no new table is exported: the service stacks reach them by their fixed names (CQ-15)", () => {
      const outputs = JSON.stringify(templates.userStoreTemplate.toJSON().Outputs ?? {});
      expect(outputs).not.toContain("VerifiedAddressClaims");
      expect(outputs).not.toContain("SignUpEmailClaims");
      expect(outputs).not.toContain("AppAttest");
    });
  });

  // CQ-15: the service stacks grant their own functions access to these tables by name. Their
  // grants are tested with each service stack (NotificationFanout's Query, WeeklyDigestWorker's reads).
  test("grants nothing: no IAM policy and no function", () => {
    templates.userStoreTemplate.resourceCountIs("AWS::IAM::Policy", 0);
    templates.userStoreTemplate.resourceCountIs("AWS::Lambda::Function", 0);
  });
});
