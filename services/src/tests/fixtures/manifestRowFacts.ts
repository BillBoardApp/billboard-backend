import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { billIntroducedDate, latestManifestAction } from "../../shared/billManifestFacts";
import { chamberPassageDates } from "../../shared/billOutcomes";

/**
 * The bill facts CreateBillsManifest adds to every row it writes from a processed bill with these actions and no
 * introducedDate of its own (UX-29, UX-38), as row attributes: for tests that compare whole rows. The rules themselves
 * are tested in billManifestFacts.test.ts and billOutcomes.test.ts.
 */
export const manifestRowFacts = (actions: unknown): Record<string, AttributeValue> => {
  const introducedDate = billIntroducedDate(undefined, actions);
  const { house, senate } = chamberPassageDates(Array.isArray(actions) ? actions : undefined);
  const latest = latestManifestAction(actions);
  return {
    ...(introducedDate ? { introducedDate: { S: introducedDate } } : {}),
    ...(house ? { passedHouseOn: { S: house } } : {}),
    ...(senate ? { passedSenateOn: { S: senate } } : {}),
    ...(latest
      ? {
          latestAction: {
            M: { actionDate: { S: latest.actionDate }, ...(latest.text ? { text: { S: latest.text } } : {}) },
          },
        }
      : {}),
  };
};
