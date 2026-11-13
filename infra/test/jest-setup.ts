// Runs in every infra test file (jest.config.js, setupFilesAfterEnv).
//
// aws-cdk-lib synthesizes each app into a temporary cdk.out* directory and deletes those directories from a process
// 'exit' listener that its cloud-assembly module adds when it loads. Jest loads that module again for every test file
// and every jest.isolateModules, and its workers never emit 'exit' (https://github.com/jestjs/jest/issues/10927). So a
// run left about 100 directories behind (some 360 MB), and the listeners piled up until the eleventh raised
// MaxListenersExceededWarning. Here each test detaches the listeners it added, and the end of the file runs them, so
// each copy of the module deletes its own directories. Not sooner: a test may read an app synthesized in a beforeAll.
// CDK_NO_CLEAN_TESTS=1 keeps the directories, as with CDK's own jest-autoclean.

const isCdkCleanup = (listener: (...args: never[]) => unknown): boolean =>
  listener.toString().includes('cleanupTemporaryDirectories');

const detached: Array<() => void> = [];

const detachCdkCleanups = (): void => {
  for (const listener of process.listeners('exit')) {
    if (!isCdkCleanup(listener)) continue;
    process.removeListener('exit', listener);
    detached.push(listener as () => void);
  }
};

afterEach(detachCdkCleanups);

afterAll(() => {
  detachCdkCleanups();
  const cleanups = detached.splice(0);
  if (!process.env.CDK_NO_CLEAN_TESTS) cleanups.forEach((cleanup) => cleanup());
});
