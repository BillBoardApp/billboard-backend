export const rawCongressMemberPayload = {
  member: {
    addressInformation: {
      city: "Washington",
      district: "DC",
      officeAddress: "2446 Rayburn House Office Building",
      phoneNumber: "(202) 225-2811",
      zipCode: 20515,
    },
    bioguideId: "V000139",
    birthYear: "1983",
    cosponsoredLegislation: {
      count: 2,
      url: "https://api.congress.gov/v3/member/V000139/cosponsored-legislation",
    },
    currentMember: true,
    depiction: {
      attribution: "Image courtesy of the Member",
      imageUrl: "https://www.congress.gov/img/member/6931b7d5f478c0f1228e9abe_200.jpg",
    },
    directOrderName: "Matt Van Epps",
    district: 7,
    firstName: "Matt",
    honorificName: "Mr.",
    invertedOrderName: "Van Epps, Matt",
    lastName: "Van Epps",
    partyHistory: [
      {
        partyAbbreviation: "R",
        partyName: "Republican",
        startYear: 2025,
      },
    ],
    previousNames: [
      {
        directOrderName: "Matt Van Epps",
        firstName: "Matt",
        honorificName: "Mr.",
        invertedOrderName: "Van Epps, Matt",
        lastName: "Van Epps",
        startDate: "2025-12-04T05:00:00Z",
      },
    ],
    state: "Tennessee",
    terms: [
      {
        chamber: "House of Representatives",
        congress: 119,
        district: 7,
        memberType: "Representative",
        startYear: 2025,
        stateCode: "TN",
        stateName: "Tennessee",
      },
    ],
    updateDate: "2025-12-05T14:29:00Z",
  },
  request: {
    bioguideId: "v000139",
    contentType: "application/json",
    format: "json",
  },
} as const;

export const processedCongressMemberPayload = {
  member: {
    bioguideId: "V000139",
    name: "Matt Van Epps",
    cosponsoredLegislationCount: 2,
    sponsoredLegislationCount: 0,
    depictionImageUrl: "https://www.congress.gov/img/member/6931b7d5f478c0f1228e9abe_200.jpg",
    directOrderName: "Matt Van Epps",
    firstName: "Matt",
    lastName: "Van Epps",
    termCount: 1,
    partyAbbreviation: "R",
    partyName: "Republican",
    state: "Tennessee",
    chamber: "House of Representatives",
    congress: 119,
    district: 7,
    memberType: "Representative",
    startYear: 2025,
    stateCode: "TN",
    stateName: "Tennessee",
    updateDate: "2025-12-05T14:29:00Z",
    terms: [
      {
        chamber: "House of Representatives",
        congress: 119,
        district: 7,
        memberType: "Representative",
        startYear: 2025,
        stateCode: "TN",
        stateName: "Tennessee",
      },
    ],
  },
} as const;
