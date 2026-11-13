export function setupS3MockRequestAware<Command>(mockSend: jest.Mock, handler: (cmd: Command) => unknown) {
  mockSend.mockImplementation((cmd: Command) => {
    return handler(cmd);
  });
}

export default setupS3MockRequestAware;
