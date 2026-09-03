import { parseArgs } from "node:util";
import { FakeSpiceServer, type ServerConfig } from "./server.ts";

const { values: args } = parseArgs({
  options: {
    port: { type: "string", default: "0" },
    scenario: { type: "string" },
    password: { type: "string" },
    replay: { type: "string" },
    speed: { type: "string" },
    loop: { type: "boolean", default: false },
    tcp: { type: "string" },
  },
});

const server = new FakeSpiceServer();
const partial: Partial<ServerConfig> = {};
if (args.scenario !== undefined) partial.scenario = args.scenario;
if (args.password !== undefined) partial.password = args.password;
if (args.replay !== undefined) partial.replay = args.replay;
if (args.speed !== undefined) partial.replaySpeed = Number(args.speed);
if (args.loop) partial.replayLoop = true;
server.reset(partial);
const port = server.listen(Number(args.port));
console.log(`SPICE_FAKE_PORT=${port}`);
if (args.tcp !== undefined) {
  const tcpPort = server.listenTcp(Number(args.tcp));
  console.log(`SPICE_FAKE_TCP_PORT=${tcpPort}  (native clients: spicy --uri=spice://127.0.0.1:${tcpPort})`);
}
/* The literal address, not "localhost": Firefox with a proxying VPN extension
   has been seen to stall ws://localhost for the client's full 30 s connect
   timeout while 127.0.0.1 opened in milliseconds. */
console.log(`page http://127.0.0.1:${port}/  websocket ws://127.0.0.1:${port}/spice`);
