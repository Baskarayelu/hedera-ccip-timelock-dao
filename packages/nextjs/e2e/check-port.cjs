// Stops the e2e run before the build when its port is taken, instead of failing after it.
const net = require("net");
const port = Number(process.argv[2]);
const server = net.createServer();
server.once("error", () => {
  console.error(
    `\nPort ${port} is in use. Run the e2e tests on another one, e.g. E2E_PORT=3200 npm run next:test:e2e\n`,
  );
  process.exit(1);
});
server.listen(port, () => server.close());
