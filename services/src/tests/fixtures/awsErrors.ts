export const noSuchKeyError = (message = "NoSuchKey"): Error => {
  const err = new Error(message);
  err.name = "NoSuchKey";
  return err;
};
