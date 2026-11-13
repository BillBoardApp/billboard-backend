import type { UserType } from "@aws-sdk/client-cognito-identity-provider";

import {
  RETIRED_PROFILE_ATTRIBUTES,
  clearRetiredAttributes,
  listRetiredAttributeHolders,
  retiredAttributeHolder,
  retiredAttributesHeld,
  tallyRetiredAttributes,
} from "../shared/retiredProfileAttributes";

/*
 * UX-36 (WEB-07): the attributes apps 1.1 and earlier wrote straight to Cognito and nothing reads. The export job and
 * `npm run clear:stored-party` delete exactly these names, per user, and only from users who hold them.
 */

type FakeCommand = { constructor: { name: string }; input: Record<string, unknown> };

const user = (userName: string | undefined, names: string[]): UserType => ({
  Username: userName,
  Attributes: [
    { Name: "sub", Value: userName ?? "none" },
    { Name: "email", Value: "someone@example.com" },
    ...names.map((name) => ({ Name: name, Value: "x" })),
  ],
});

describe("retired profile attributes (UX-36)", () => {
  it("are party, gender and birth date, and nothing a current app reads", () => {
    expect(RETIRED_PROFILE_ATTRIBUTES).toEqual(["custom:politicalParty", "gender", "birthdate"]);
    for (const kept of ["sub", "email", "email_verified", "custom:state", "custom:district"]) {
      expect(RETIRED_PROFILE_ATTRIBUTES as readonly string[]).not.toContain(kept);
    }
  });

  it("finds the ones a user holds, in a fixed order, and ignores every other attribute", () => {
    expect(
      retiredAttributesHeld(user("u-1", ["birthdate", "custom:state", "custom:politicalParty", "custom:birthYear"])),
    ).toEqual(["custom:politicalParty", "birthdate"]);
    expect(retiredAttributesHeld(user("u-2", ["custom:district"]))).toEqual([]);
    expect(retiredAttributesHeld({})).toEqual([]);
    expect(retiredAttributeHolder(user("u-2", []))).toBeNull();
    expect(retiredAttributeHolder(user("u-3", ["gender"]))).toEqual({ userName: "u-3", held: ["gender"] });
  });

  it("tallies holders and each attribute", () => {
    expect(
      tallyRetiredAttributes([
        { userName: "a", held: ["custom:politicalParty"] },
        { userName: "b", held: ["custom:politicalParty", "gender", "birthdate"] },
      ]),
    ).toEqual({ holding: 2, byAttribute: { "custom:politicalParty": 2, gender: 1, birthdate: 1 } });
    expect(tallyRetiredAttributes([])).toEqual({
      holding: 0,
      byAttribute: { "custom:politicalParty": 0, gender: 0, birthdate: 0 },
    });
  });

  it("lists every page of the pool and keeps only the holders", async () => {
    const send = jest
      .fn()
      .mockResolvedValueOnce({
        Users: [user("u-1", ["custom:politicalParty"]), user("u-2", [])],
        PaginationToken: "p2",
      })
      .mockResolvedValueOnce({ Users: [user("u-3", ["gender"])] });

    const listing = await listRetiredAttributeHolders({ send }, "pool-1");

    expect(send.mock.calls.map(([command]: [FakeCommand]) => [command.constructor.name, command.input])).toEqual([
      ["ListUsersCommand", { UserPoolId: "pool-1", Limit: 60, PaginationToken: undefined }],
      ["ListUsersCommand", { UserPoolId: "pool-1", Limit: 60, PaginationToken: "p2" }],
    ]);
    expect(listing).toEqual({
      users: 3,
      holders: [
        { userName: "u-1", held: ["custom:politicalParty"] },
        { userName: "u-3", held: ["gender"] },
      ],
    });
  });

  it("deletes only the held retired names, counts failures by name and goes on", async () => {
    const send = jest.fn(async (command: FakeCommand) => {
      if (command.input.Username === "u-2")
        throw Object.assign(new Error("Rate exceeded for u-2"), { name: "Throttled" });
      return {};
    });

    const result = await clearRetiredAttributes({ send }, "pool-1", [
      { userName: "u-1", held: ["custom:politicalParty"] },
      { userName: "u-2", held: ["gender"] },
      // A malformed holder never widens the delete: names outside the list are dropped.
      { userName: "u-3", held: ["birthdate", "custom:state" as never] },
      { userName: "", held: ["gender"] },
    ]);

    expect(send.mock.calls.map(([command]) => [command.constructor.name, command.input])).toEqual([
      [
        "AdminDeleteUserAttributesCommand",
        { UserPoolId: "pool-1", Username: "u-1", UserAttributeNames: ["custom:politicalParty"] },
      ],
      ["AdminDeleteUserAttributesCommand", { UserPoolId: "pool-1", Username: "u-2", UserAttributeNames: ["gender"] }],
      [
        "AdminDeleteUserAttributesCommand",
        { UserPoolId: "pool-1", Username: "u-3", UserAttributeNames: ["birthdate"] },
      ],
    ]);
    expect(result).toEqual({ cleared: 2, failed: 2, errorNames: { Throttled: 1, NoUserName: 1 } });
  });
});
