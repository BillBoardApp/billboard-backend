import * as cdk from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as cognito from "aws-cdk-lib/aws-cognito";
import { Template } from "aws-cdk-lib/assertions";
import { UserApiCanary, type UserApiCanaryProps } from "../lib/constructs/user-api-canary";

/**
 * The canary construct on its own: how it reads the smoke account's secret (UA-04). The production wiring (the
 * name in cdk.json) is pinned in app-wide-invariants.test.ts.
 */
const ACCOUNT_SECRET = "Billboard/CanarySmokeTestCredentials";
const FIXTURES_SECRET = "Billboard/CanarySmokeTestFixtures";

const canaryTemplate = (props: Partial<UserApiCanaryProps> = {}): Template => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "CanaryStack", { env: { account: "123456789012", region: "us-east-1" } });
  const api = new apigateway.RestApi(stack, "Api");
  api.root.addMethod("GET", new apigateway.MockIntegration());
  const userPoolClient = new cognito.UserPool(stack, "Pool").addClient("CanaryClient");
  new UserApiCanary(stack, "Canary", { api, userPoolClient, ...props });
  return Template.fromStack(stack);
};

const canaryEnvironment = (template: Template): Record<string, string> => {
  const [canary] = Object.values(template.findResources("AWS::Synthetics::Canary"));
  return canary.Properties.RunConfig.EnvironmentVariables;
};

/** Every statement in the canary role's inline policies and in any policy attached to the role. */
const canaryRoleStatements = (template: Template): Array<Record<string, any>> => {
  const [roleId, role] = Object.entries(template.findResources("AWS::IAM::Role")).find(([id]) =>
    id.startsWith("SyntheticsCanaryRole"),
  )!;
  const inline = (role.Properties.Policies ?? []).flatMap((policy: any) => policy.PolicyDocument.Statement);
  const attached = Object.values(template.findResources("AWS::IAM::Policy"))
    .filter((policy) => JSON.stringify(policy.Properties.Roles).includes(roleId))
    .flatMap((policy: any) => policy.Properties.PolicyDocument.Statement);
  return [...inline, ...attached];
};

const secretStatements = (template: Template) =>
  canaryRoleStatements(template).filter((statement) => JSON.stringify(statement.Action).includes("secretsmanager:"));

const resourcesOf = (statement: Record<string, any>): unknown[] =>
  Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource];

describe("UserApiCanary smoke-test secrets", () => {
  test("without a secret name the signed-in checks are skipped: no name in the environment, no Secrets Manager access", () => {
    const template = canaryTemplate();

    expect(canaryEnvironment(template)).toMatchObject({
      SMOKE_TEST_SECRET_NAME: "",
      SMOKE_TEST_FIXTURES_SECRET_NAME: "",
      SMOKE_TEST_WRITE_CHECKS: "false",
    });
    expect(secretStatements(template)).toEqual([]);
  });

  test("the account secret's name is the environment value, and the role gets GetSecretValue on that one ARN only", () => {
    const template = canaryTemplate({ smokeTestSecretName: ACCOUNT_SECRET });

    expect(canaryEnvironment(template)).toMatchObject({
      SMOKE_TEST_SECRET_NAME: ACCOUNT_SECRET,
      SMOKE_TEST_FIXTURES_SECRET_NAME: "",
      SMOKE_TEST_WRITE_CHECKS: "false",
    });

    const statements = secretStatements(template);
    expect(statements).toHaveLength(1);
    // One action (no DescribeSecret, no list), one resource, no wildcard beyond Secrets Manager's "-??????" suffix.
    expect(statements[0]).toMatchObject({ Effect: "Allow", Action: "secretsmanager:GetSecretValue" });
    const resources = resourcesOf(statements[0]);
    expect(resources).toHaveLength(1);
    const arn = JSON.stringify(resources[0]);
    expect(arn).toContain(`:secret:${ACCOUNT_SECRET}-??????`);
    expect(arn.replace("-??????", "")).not.toMatch(/[*?]/);
  });

  test("a fixtures secret adds its own ARN to the same statement, and nothing else changes", () => {
    const template = canaryTemplate({
      smokeTestSecretName: ACCOUNT_SECRET,
      smokeTestFixturesSecretName: FIXTURES_SECRET,
    });

    const statements = secretStatements(template);
    expect(statements).toHaveLength(1);
    expect(statements[0].Action).toBe("secretsmanager:GetSecretValue");
    expect(resourcesOf(statements[0]).map((arn) => JSON.stringify(arn))).toEqual([
      expect.stringContaining(`:secret:${ACCOUNT_SECRET}-??????`),
      expect.stringContaining(`:secret:${FIXTURES_SECRET}-??????`),
    ]);
  });

  test("the secret grant adds no IAM policy resource: it sits in the role's one inline policy", () => {
    const withSecret = canaryTemplate({ smokeTestSecretName: ACCOUNT_SECRET });
    const without = canaryTemplate();

    expect(Object.keys(withSecret.findResources("AWS::IAM::Policy"))).toEqual(
      Object.keys(without.findResources("AWS::IAM::Policy")),
    );
    expect(Object.keys(withSecret.findResources("AWS::IAM::Role"))).toEqual(
      Object.keys(without.findResources("AWS::IAM::Role")),
    );
  });
});
