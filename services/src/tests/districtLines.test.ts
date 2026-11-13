import { geocoderVintageFor } from "../shared/districtLines";

describe("geocoderVintageFor", () => {
  it("uses the 119th-Congress vintage before noon Eastern on 2027-01-03 and the current vintage from then on", () => {
    expect(geocoderVintageFor("TX", Date.parse("2026-11-05T12:00:00Z"))).toBe("ACS2025_Current");
    expect(geocoderVintageFor("TX", Date.parse("2027-01-03T16:59:59.999Z"))).toBe("ACS2025_Current");
    expect(geocoderVintageFor("TX", Date.parse("2027-01-03T17:00:00Z"))).toBe("Current_Current");
    expect(geocoderVintageFor("TX", new Date("2027-06-01T00:00:00Z"))).toBe("Current_Current");
  });

  it("keeps Missouri on the 119th-Congress vintage at any time", () => {
    expect(geocoderVintageFor("MO", Date.parse("2026-11-05T12:00:00Z"))).toBe("ACS2025_Current");
    expect(geocoderVintageFor("MO", Date.parse("2027-06-01T00:00:00Z"))).toBe("ACS2025_Current");
  });
});
