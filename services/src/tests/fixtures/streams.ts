import { Readable } from "stream";

export const jsonReadable = (payload: unknown): Readable => {
  const stream = new Readable();
  stream.push(JSON.stringify(payload));
  stream.push(null);
  return stream;
};

export const bodyWithTransformToString = (payload: unknown): { transformToString: jest.Mock } => {
  return {
    transformToString: jest.fn().mockResolvedValue(JSON.stringify(payload)),
  };
};
