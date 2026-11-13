const mockS3Send = jest.fn();

jest.mock("@aws-sdk/client-s3", () => ({
  S3Client: jest.fn(() => ({ send: mockS3Send })),
  PutObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
  GetObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
  DeleteObjectCommand: jest.fn().mockImplementation((input) => ({ __type: "DeleteObjectCommand", input })),
}));

import { S3Client } from "@aws-sdk/client-s3";
import { noSuchKeyError } from "./fixtures/awsErrors";
import {
  ProcessedCongressMemberDao,
  PROCESSED_CONGRESS_MEMBERS_ROOT,
  buildProcessedCongressMemberKey,
  buildProcessedCongressMemberKeyCandidates,
} from "../adapters/processedCongressMemberDao";

describe("ProcessedCongressMemberDao", () => {
  const bucketName = "test-bucket";
  let dao: ProcessedCongressMemberDao;

  beforeEach(() => {
    mockS3Send.mockReset();
    dao = new ProcessedCongressMemberDao(new S3Client({}) as S3Client, bucketName);
    jest.spyOn(console, "log").mockImplementation();
    jest.spyOn(console, "warn").mockImplementation();
    jest.spyOn(console, "error").mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("builds the flattened processed key", () => {
    expect(PROCESSED_CONGRESS_MEMBERS_ROOT).toBe("processed-congress-members");
    expect(buildProcessedCongressMemberKey("A000001")).toBe("processed-congress-members/A000001.json");
  });

  it("returns only the flattened key candidate", () => {
    expect(buildProcessedCongressMemberKeyCandidates("A000001")).toEqual(["processed-congress-members/A000001.json"]);
  });

  it("stores payload under the flattened key", async () => {
    mockS3Send.mockResolvedValueOnce({});

    const payload = { member: { bioguideId: "A000001", name: "Test" } };
    await dao.store("A000001", payload);

    expect(mockS3Send).toHaveBeenCalledTimes(1);
    const putInput = mockS3Send.mock.calls[0][0].input;
    expect(putInput).toMatchObject({
      Bucket: bucketName,
      Key: "processed-congress-members/A000001.json",
    });
    // Ensure it is JSON; formatting may include whitespace.
    expect(JSON.parse(putInput.Body)).toEqual(payload);
  });

  it("gets payload from the flattened key", async () => {
    const payload = { member: { bioguideId: "A000001", name: "Test" } };
    mockS3Send.mockResolvedValueOnce({
      Body: {
        transformToString: jest.fn().mockResolvedValue(JSON.stringify(payload)),
      },
    });

    const found = await dao.get("A000001");
    expect(found).toEqual(payload);

    expect(mockS3Send).toHaveBeenCalledTimes(1);
    const getInput = mockS3Send.mock.calls[0][0].input;
    expect(getInput).toMatchObject({
      Bucket: bucketName,
      Key: "processed-congress-members/A000001.json",
    });
  });

  it("returns null when key is missing", async () => {
    mockS3Send.mockRejectedValueOnce(noSuchKeyError());

    const found = await dao.get("A000001");
    expect(found).toBeNull();
    expect(mockS3Send).toHaveBeenCalledTimes(1);
  });

  it("deletes the flattened key", async () => {
    mockS3Send.mockResolvedValueOnce({});

    await dao.delete("G000596");

    expect(mockS3Send).toHaveBeenCalledTimes(1);
    expect(mockS3Send.mock.calls[0][0]).toEqual({
      __type: "DeleteObjectCommand",
      input: { Bucket: bucketName, Key: "processed-congress-members/G000596.json" },
    });
  });
});
