import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import {
  ACCOUNT_EMAIL_FROM,
  ACCOUNT_EMAIL_FROM_ADDRESS,
  ACCOUNT_EMAIL_FROM_NAME,
  ACCOUNT_EMAIL_REPLY_TO,
  DMARC_RECORD,
  DMARC_RECORD_NAME,
  DMARC_REPORT_ADDRESS,
  EMAIL_DOMAIN,
  MAIL_FROM_DOMAIN,
  MAIL_FROM_MX_PRIORITY,
  MAIL_FROM_SPF_RECORD,
  SES_BOUNCE_RATE_ALARM_THRESHOLD,
  SES_COMPLAINT_RATE_ALARM_THRESHOLD,
  SES_CONFIGURATION_SET_NAME,
  SES_EVENT_DIMENSION_NAME,
  SES_PUBLISHED_EVENTS,
  VERIFICATION_EMAIL_BODY,
  VERIFICATION_EMAIL_SUBJECT,
} from "../lib/config/email-constants";
import { EmailStack } from "../lib/stacks/email";

/**
 * REL-54 step 1 (feature review S13): the SES identity for billboard-project.com, its DNS records, its
 * configuration set and the domain's DMARC record. test/app-wide-invariants.test.ts checks the same stack in the
 * real app: the zone it writes to, that no existing record of the domain changes, and (step 2) that the user pool sends
 * through this identity and configuration set.
 */

const ZONE_ID = "Z0TESTZONE0000";

type CfnResource = { Type: string; Properties: Record<string, any> };

const template = Template.fromStack(
  new EmailStack(new cdk.App(), "EmailStack", {
    hostedZoneId: ZONE_ID,
    env: { account: "111111111111", region: "us-east-1" },
  }),
);

const resourcesOf = (type: string): Array<[string, CfnResource]> =>
  Object.entries(template.findResources(type) as Record<string, CfnResource>);

const [[identityId, identity]] = resourcesOf("AWS::SES::EmailIdentity");
const [[configurationSetId, configurationSet]] = resourcesOf("AWS::SES::ConfigurationSet");
const records = resourcesOf("AWS::Route53::RecordSet").map(([, resource]) => resource.Properties);

describe("EmailStack (REL-54 step 1)", () => {
  test("holds the identity, its configuration set and event destination, and six DNS records, nothing else", () => {
    const types = Object.values(template.toJSON().Resources as Record<string, CfnResource>)
      .map((resource) => resource.Type)
      .filter((type) => type !== "AWS::CDK::Metadata")
      .sort();
    expect(types).toEqual([
      "AWS::Route53::RecordSet",
      "AWS::Route53::RecordSet",
      "AWS::Route53::RecordSet",
      "AWS::Route53::RecordSet",
      "AWS::Route53::RecordSet",
      "AWS::Route53::RecordSet",
      "AWS::SES::ConfigurationSet",
      "AWS::SES::ConfigurationSetEventDestination",
      "AWS::SES::EmailIdentity",
    ]);
  });

  test("the domain identity signs with Easy DKIM (2048-bit) and uses the MAIL FROM subdomain and the configuration set", () => {
    const { Tags, ...properties } = identity.Properties;
    expect(properties).toEqual({
      EmailIdentity: "billboard-project.com",
      // Easy DKIM: no private key or selector of our own.
      DkimAttributes: { SigningEnabled: true },
      DkimSigningAttributes: { NextSigningKeyLength: "RSA_2048_BIT" },
      MailFromAttributes: {
        MailFromDomain: "bounce.billboard-project.com",
        // A missing MX falls back to amazonses.com; a sign-up code is never refused for it.
        BehaviorOnMxFailure: "USE_DEFAULT_VALUE",
      },
      ConfigurationSetAttributes: { ConfigurationSetName: { Ref: configurationSetId } },
      FeedbackAttributes: { EmailForwardingEnabled: true },
    });
    expect(EMAIL_DOMAIN).toBe("billboard-project.com");
    expect(MAIL_FROM_DOMAIN).toBe("bounce.billboard-project.com");
    expect(MAIL_FROM_DOMAIN.endsWith(`.${EMAIL_DOMAIN}`)).toBe(true);
  });

  test("the three DKIM CNAMEs are SES's tokens, in the hosted zone", () => {
    const cnames = records.filter((record) => record.Type === "CNAME");
    expect(cnames).toEqual(
      [1, 2, 3].map((n) => ({
        HostedZoneId: ZONE_ID,
        Name: { "Fn::GetAtt": [identityId, `DkimDNSTokenName${n}`] },
        ResourceRecords: [{ "Fn::GetAtt": [identityId, `DkimDNSTokenValue${n}`] }],
        TTL: "1800",
        Type: "CNAME",
      })),
    );
  });

  test("the MAIL FROM MX and SPF are on the subdomain only, with SES's feedback endpoint and -all", () => {
    expect(MAIL_FROM_SPF_RECORD).toBe("v=spf1 include:amazonses.com -all");
    const named = records.filter((record) => record.Name === "bounce.billboard-project.com.");
    expect(named).toEqual([
      {
        HostedZoneId: ZONE_ID,
        Name: "bounce.billboard-project.com.",
        ResourceRecords: [`${MAIL_FROM_MX_PRIORITY} feedback-smtp.us-east-1.amazonses.com`],
        TTL: "1800",
        Type: "MX",
      },
      {
        HostedZoneId: ZONE_ID,
        Name: "bounce.billboard-project.com.",
        ResourceRecords: ['"v=spf1 include:amazonses.com -all"'],
        TTL: "1800",
        Type: "TXT",
      },
    ]);
  });

  test("writes no record at the apex and nothing outside the zone", () => {
    expect(records).toHaveLength(6);
    records.forEach((record) => {
      expect(record.HostedZoneId).toBe(ZONE_ID);
      expect(JSON.stringify(record.Name)).not.toMatch(/"billboard-project\.com\.?"/);
    });
    // Its named records: the MAIL FROM pair and DMARC. The other three are SES's DKIM tokens.
    expect(records.filter((record) => typeof record.Name === "string").map((record) => [record.Name, record.Type]))
      .toEqual([
        ["bounce.billboard-project.com.", "MX"],
        ["bounce.billboard-project.com.", "TXT"],
        ["_dmarc.billboard-project.com.", "TXT"],
      ]);
  });

  // Project decision 2026-10-29: monitoring only. A stricter policy waits for Microsoft 365 DKIM (RUNBOOK 23.6).
  test("the DMARC record is p=none with aggregate reports to dmarc@ in the domain, and nothing more", () => {
    expect(DMARC_RECORD).toBe("v=DMARC1; p=none; rua=mailto:dmarc@billboard-project.com");
    expect(DMARC_RECORD_NAME).toBe("_dmarc.billboard-project.com");
    const dmarc = records.filter((record) => JSON.stringify(record.Name).toLowerCase().includes("_dmarc"));
    expect(dmarc).toEqual([
      {
        HostedZoneId: ZONE_ID,
        Name: "_dmarc.billboard-project.com.",
        ResourceRecords: ['"v=DMARC1; p=none; rua=mailto:dmarc@billboard-project.com"'],
        TTL: "1800",
        Type: "TXT",
      },
    ]);
    // No forensic reports (ruf), no quarantine or reject, and no subdomain, percentage or alignment overrides.
    const tags = DMARC_RECORD.split(";").map((tag) => tag.trim().split("=")[0]);
    expect(tags).toEqual(["v", "p", "rua"]);
    // The report address is in the domain itself, so no authorization record (`<domain>._report._dmarc.<other>`) is
    // needed anywhere, and the stack writes none.
    expect(DMARC_REPORT_ADDRESS).toBe("dmarc@billboard-project.com");
    expect(DMARC_REPORT_ADDRESS.split("@")[1]).toBe(EMAIL_DOMAIN);
    expect(records.filter((record) => JSON.stringify(record.Name).includes("_report"))).toEqual([]);
  });

  // The account has Virtual Deliverability Manager (engagement tracking, optimized shared delivery) and Auto Validation
  // on, set outside the app; a configuration set without its own settings takes the account's. The set turns all three
  // off, so a code email carries no tracking pixel, is not held back, and goes to every address (RUNBOOK 23.1).
  test("the configuration set keeps reputation metrics, suppresses bounced and complained addresses, and turns off VDM and Auto Validation", () => {
    const { Tags, ...properties } = configurationSet.Properties;
    expect(properties).toEqual({
      Name: SES_CONFIGURATION_SET_NAME,
      ReputationOptions: { ReputationMetricsEnabled: true },
      SendingOptions: { SendingEnabled: true },
      SuppressionOptions: {
        SuppressedReasons: ["BOUNCE", "COMPLAINT"],
        ValidationOptions: { ConditionThreshold: { ConditionThresholdEnabled: "DISABLED" } },
      },
      VdmOptions: {
        DashboardOptions: { EngagementMetrics: "DISABLED" },
        GuardianOptions: { OptimizedSharedDelivery: "DISABLED" },
      },
    });
    expect(properties).not.toHaveProperty("TrackingOptions");
    expect(SES_CONFIGURATION_SET_NAME).toBe("BillboardAccountEmail");
  });

  test("its one event destination publishes counts to CloudWatch only, and no open or click tracking", () => {
    const destinations = resourcesOf("AWS::SES::ConfigurationSetEventDestination");
    expect(destinations).toHaveLength(1);
    expect(destinations[0][1].Properties).toEqual({
      ConfigurationSetName: { Ref: configurationSetId },
      EventDestination: {
        Name: "CloudWatchEvents",
        Enabled: true,
        MatchingEventTypes: ["send", "delivery", "bounce", "complaint", "reject", "deliveryDelay"],
        CloudWatchDestination: {
          DimensionConfigurations: [
            {
              DimensionName: "ses:configuration-set",
              DimensionValueSource: "messageTag",
              DefaultDimensionValue: SES_CONFIGURATION_SET_NAME,
            },
          ],
        },
      },
    });
    expect(SES_EVENT_DIMENSION_NAME).toBe("ses:configuration-set");
    expect(SES_PUBLISHED_EVENTS).not.toContain("open");
    expect(SES_PUBLISHED_EVENTS).not.toContain("click");
  });

  // Step 2's user pool names the identity by its fixed ARN, and Cognito sends with its service-linked role, which
  // needs no sending authorization policy on a same-account identity (Cognito Developer Guide, "Email settings").
  test("grants nothing and exports nothing: step 2's user pool names the identity by its fixed ARN", () => {
    expect(resourcesOf("AWS::IAM::Policy")).toEqual([]);
    expect(resourcesOf("AWS::IAM::Role")).toEqual([]);
    const outputs = template.toJSON().Outputs as Record<string, { Export?: unknown }>;
    expect(Object.keys(outputs).sort()).toEqual(["EmailConfigurationSetName", "EmailIdentityName"]);
    Object.values(outputs).forEach((output) => expect(output.Export).toBeUndefined());
  });

  // REL-54 step 2: the user pool's sender and copy, word for word as the project approved them on 2026-10-29 (RUNBOOK
  // 23.4). Any other wording goes back to the project's maintainers first.
  test("step 2's sender, Reply-To and verification copy are the project's, at the verified domain", () => {
    expect({
      from: ACCOUNT_EMAIL_FROM,
      fromName: ACCOUNT_EMAIL_FROM_NAME,
      fromAddress: ACCOUNT_EMAIL_FROM_ADDRESS,
      replyTo: ACCOUNT_EMAIL_REPLY_TO,
      subject: VERIFICATION_EMAIL_SUBJECT,
      body: VERIFICATION_EMAIL_BODY,
    }).toEqual({
      from: "Billboard <no-reply@billboard-project.com>",
      fromName: "Billboard",
      fromAddress: "no-reply@billboard-project.com",
      replyTo: "contact@billboard-project.com",
      subject: "Your Billboard verification code",
      body: "Your Billboard verification code is {####}. Enter it in the app to continue. If you didn't ask for this code, you can ignore this email.",
    });
    expect(ACCOUNT_EMAIL_FROM_ADDRESS.endsWith(`@${EMAIL_DOMAIN}`)).toBe(true);
    // Exactly one code placeholder, and no exclamation mark (the project's rule for the copy).
    expect(VERIFICATION_EMAIL_BODY.match(/\{####\}/g)).toHaveLength(1);
    expect(`${VERIFICATION_EMAIL_SUBJECT} ${VERIFICATION_EMAIL_BODY}`).not.toContain("!");
  });

  test("the alarm thresholds sit below the rates at which SES reviews an account (5% bounces, 0.1% complaints)", () => {
    expect(SES_BOUNCE_RATE_ALARM_THRESHOLD).toBe(0.03);
    expect(SES_COMPLAINT_RATE_ALARM_THRESHOLD).toBe(0.0005);
    expect(SES_BOUNCE_RATE_ALARM_THRESHOLD).toBeLessThan(0.05);
    expect(SES_COMPLAINT_RATE_ALARM_THRESHOLD).toBeLessThan(0.001);
  });
});
