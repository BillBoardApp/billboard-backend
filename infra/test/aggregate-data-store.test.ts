import { Match } from "aws-cdk-lib/assertions";
import { synthesizeStacks } from "./helpers/synth-stacks";

const templates = synthesizeStacks();

describe("AggregateDataStoreStack", () => {
  test("creates stats, vote-profile, and legislative-profile aggregate tables", () => {
    templates.aggregateTemplate.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "CongressMembersStats",
    });
    templates.aggregateTemplate.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "CongressMemberVoteProfiles",
      KeySchema: Match.arrayWith([
        Match.objectLike({ AttributeName: "bioguideId", KeyType: "HASH" }),
        Match.objectLike({ AttributeName: "billGuid", KeyType: "RANGE" }),
      ]),
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: "BillGuidIndex",
        }),
      ]),
    });
    templates.aggregateTemplate.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "CongressMemberLegislativeProfiles",
      KeySchema: Match.arrayWith([
        Match.objectLike({ AttributeName: "bioguideId", KeyType: "HASH" }),
        Match.objectLike({ AttributeName: "billGuid", KeyType: "RANGE" }),
      ]),
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: "BillGuidIndex",
        }),
      ]),
    });
  });

  test("protects every aggregate table with deletion protection, PITR and RETAIN", () => {
    templates.aggregateTemplate.resourceCountIs("AWS::DynamoDB::Table", 3);
    templates.aggregateTemplate.allResourcesProperties("AWS::DynamoDB::Table", {
      DeletionProtectionEnabled: true,
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    });
    templates.aggregateTemplate.allResources("AWS::DynamoDB::Table", {
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
    });
  });

  // CQ-15: AnalyticsServiceStack and UserAPIServiceStack grant their own functions access to these
  // tables by name; the member readers' stats-table access is tested with UserAPIServiceStack.
  test("grants nothing: no IAM policy and no function", () => {
    templates.aggregateTemplate.resourceCountIs("AWS::IAM::Policy", 0);
    templates.aggregateTemplate.resourceCountIs("AWS::Lambda::Function", 0);
  });
});
