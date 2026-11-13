import { SENATORS_XML_URL, cachedLoader, fetchSenateSeats, parseSenatorsXml } from "../shared/senateSeats";

// The shape of https://www.senate.gov/general/contact_information/senators_cfm.xml (REL-52), with made-up members.
const member = (fields: Record<string, string>): string =>
  `  <member>\n${Object.entries(fields)
    .map(([name, value]) => `    <${name}>${value}</${name}>`)
    .join("\n")}\n  </member>`;

const SENATORS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<contact_information>
${member({
  member_full: "Doe (D-MN)",
  last_name: "Doe",
  first_name: "Jane",
  party: "D",
  state: "MN",
  address: "425 Dirksen Senate Office Building Washington DC 20510",
  phone: "(202) 224-3244",
  email: "https://www.example.senate.gov/contact",
  website: "https://www.example.senate.gov",
  class: "Class I",
  bioguide_id: "D000001",
})}
${member({ member_full: "Roe (R-GA)", state: "GA", class: "Class III", bioguide_id: "R000002", leadership_position: "Whip" })}
${member({ member_full: "Poe (I-ME)", state: "ME", class: " Class II ", bioguide_id: "p000003" })}
${member({ member_full: "No class (D-CA)", state: "CA", class: "", bioguide_id: "N000004" })}
${member({ member_full: "Bad id (D-CA)", state: "CA", class: "Class I", bioguide_id: "N04" })}
${member({ member_full: "No state", state: "", class: "Class III", bioguide_id: "N000005" })}
</contact_information>
`;

describe("parseSenatorsXml", () => {
  it("reads each senator's seat class and state by bioguide id, skipping incomplete members", () => {
    expect(Object.fromEntries(parseSenatorsXml(SENATORS_XML))).toEqual({
      D000001: { senateClass: 1, stateCode: "MN" },
      R000002: { senateClass: 3, stateCode: "GA" },
      P000003: { senateClass: 2, stateCode: "ME" },
    });
  });

  it("finds nothing in a page that is not the list", () => {
    expect(parseSenatorsXml("<html><body>Access Denied</body></html>").size).toBe(0);
  });
});

describe("fetchSenateSeats", () => {
  const fetchSpy = jest.spyOn(global, "fetch");

  afterEach(() => fetchSpy.mockReset());
  afterAll(() => fetchSpy.mockRestore());

  it("reads the Senate's list with BillBoard's user agent", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(SENATORS_XML, { status: 200 }));

    const seats = await fetchSenateSeats();

    expect(seats.size).toBe(3);
    expect(fetchSpy).toHaveBeenCalledWith(
      SENATORS_XML_URL,
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ "User-Agent": expect.stringContaining("BillBoardFetcher") }),
      }),
    );
  });

  it("fails on an error status, and on a list without a seat", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("busy", { status: 503 }));
    await expect(fetchSenateSeats()).rejects.toThrow("answered 503");

    fetchSpy.mockResolvedValueOnce(new Response("<html>Access Denied</html>", { status: 200 }));
    await expect(fetchSenateSeats()).rejects.toThrow("held no seat");
  });
});

describe("cachedLoader", () => {
  it("shares one read between callers until it expires", async () => {
    let now = 0;
    const load = jest.fn().mockResolvedValueOnce("first").mockResolvedValueOnce("second");
    const get = cachedLoader(load, { ttlMs: 1000, retryAfterMs: 100, now: () => now });

    expect(await Promise.all([get(), get()])).toEqual(["first", "first"]);
    now = 999;
    expect(await get()).toBe("first");
    now = 1000;
    expect(await get()).toBe("second");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("answers null after a failed read, and tries again only after retryAfterMs", async () => {
    let now = 0;
    const onError = jest.fn();
    const load = jest.fn().mockRejectedValueOnce(new Error("timed out")).mockResolvedValueOnce("list");
    const get = cachedLoader(load, { ttlMs: 1000, retryAfterMs: 100, now: () => now, onError });

    expect(await get()).toBeNull();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "timed out" }));
    now = 99;
    expect(await get()).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
    now = 100;
    expect(await get()).toBe("list");
    expect(load).toHaveBeenCalledTimes(2);
  });
});
