/* File transfer to the guest agent: the start message, the data, the
   agent's answers, and what onfilexfer reports for each of them. */
import { expect, type FileXferEvent, type SpiceClient, type SpiceControl, test } from "./fixtures";

const XFER_START = 10;
const XFER_STATUS = 11;
const XFER_DATA = 12;
const DETAILED_ERRORS_CAP = 1 << 14;
const STATUS = {
  CAN_SEND_DATA: 0,
  CANCELLED: 1,
  ERROR: 2,
  SUCCESS: 3,
  NOT_ENOUGH_SPACE: 4,
  SESSION_LOCKED: 5,
  VDAGENT_NOT_CONNECTED: 6,
  DISABLED: 7,
};

type Fields = Record<string, unknown>;

async function agentMessages(spice: SpiceControl, type: number): Promise<Fields[]> {
  return (await spice.inbound("main", "agent_data")).map((m) => m.fields as Fields).filter((f) => f.agentType === type);
}

async function bytesSent(spice: SpiceControl, id: number) {
  return (await agentMessages(spice, XFER_DATA)).filter((f) => f.xferId === id).reduce((n, f) => n + (f.xferSize as number), 0);
}

async function started(spice: SpiceControl, id: number) {
  await expect.poll(async () => (await agentMessages(spice, XFER_START)).some((f) => f.xferId === id)).toBe(true);
}

async function last(client: SpiceClient, id: number): Promise<FileXferEvent | undefined> {
  return (await client.xfers()).filter((e) => e.id === id).at(-1);
}

test.describe("file transfer", () => {
  test.beforeEach(async ({ client, spice }) => {
    await spice.reset({ agentConnected: true });
    await client.connectReady({ filexfer: true });
    await spice.send("main", "agentToken", { tokens: 100000 });
  });

  test("the client asks the agent for detailed results", async ({ spice }) => {
    const [announce] = await agentMessages(spice, 6);
    expect((announce.caps as number) & DETAILED_ERRORS_CAP).toBeTruthy();
  });

  test("a name goes out as UTF-8, with the file's size", async ({ client, spice }) => {
    const id = await client.sendFile("Résumé 日本 🎉.txt", 5);
    await started(spice, id);
    const [start] = await agentMessages(spice, XFER_START);
    expect(start).toMatchObject({ name: "Résumé 日本 🎉.txt", fileSize: 5 });
  });

  test("a backslash is escaped, as the guest's key file parser expects", async ({ client, spice }) => {
    const id = await client.sendFile("a\\b.txt", 1);
    await started(spice, id);
    const [start] = await agentMessages(spice, XFER_START);
    expect(start.keyfile).toContain("name=a\\\\b.txt\n");
  });

  test("data follows the agent's go-ahead, and success reports done", async ({ client, spice }) => {
    const size = 200_000;
    const id = await client.sendFile("big.bin", size);
    await started(spice, id);
    await client.page.waitForTimeout(100);
    expect(await bytesSent(spice, id)).toBe(0);
    await spice.send("main", "agentFileXferStatus", { id, result: STATUS.CAN_SEND_DATA });
    await expect.poll(() => bytesSent(spice, id)).toBe(size);
    await expect.poll(() => last(client, id)).toMatchObject({ state: "progress", sent: size, size, name: "big.bin" });
    await spice.send("main", "agentFileXferStatus", { id, result: STATUS.SUCCESS });
    await expect.poll(() => last(client, id)).toMatchObject({ state: "done", sent: size });
    expect(client.pageErrors).toEqual([]);
  });

  test("an empty file completes", async ({ client, spice }) => {
    const id = await client.sendFile("empty.txt", 0);
    await started(spice, id);
    await spice.send("main", "agentFileXferStatus", { id, result: STATUS.CAN_SEND_DATA });
    await expect.poll(async () => (await agentMessages(spice, XFER_DATA)).filter((f) => f.xferId === id).length).toBe(1);
    await spice.send("main", "agentFileXferStatus", { id, result: STATUS.SUCCESS });
    await expect.poll(() => last(client, id)).toMatchObject({ state: "done", sent: 0 });
  });

  const failures: Array<[string, Fields, Partial<FileXferEvent>]> = [
    ["no free space, with the guest's free space", { result: STATUS.NOT_ENOUGH_SPACE, freeSpace: 1234567 }, { reason: "no-space", free_space: 1234567 }],
    ["a locked session", { result: STATUS.SESSION_LOCKED }, { reason: "locked" }],
    ["no agent in the user's session", { result: STATUS.VDAGENT_NOT_CONNECTED }, { reason: "no-session" }],
    ["transfers turned off in the guest", { result: STATUS.DISABLED }, { reason: "disabled" }],
    ["a name the guest refuses", { result: STATUS.ERROR, errorType: 0, errorCode: 10 }, { reason: "invalid-name" }],
    ["any other error, with its code", { result: STATUS.ERROR, errorType: 0, errorCode: 24 }, { reason: "error", error_code: 24 }],
    ["an error with no detail", { result: STATUS.ERROR }, { reason: "error" }],
    ["the guest cancelling", { result: STATUS.CANCELLED }, { reason: "cancelled-by-guest" }],
  ];
  for (const [what, status, expected] of failures) {
    test(`reports ${what}`, async ({ client, spice }) => {
      const id = await client.sendFile("x.bin", 10);
      await started(spice, id);
      await spice.send("main", "agentFileXferStatus", { id, ...status });
      await expect.poll(() => last(client, id)).toMatchObject({ state: "failed", ...expected });
    });
  }

  test("cancelling before the go-ahead tells the agent and sends nothing", async ({ client, spice }) => {
    const id = await client.sendFile("x.bin", 100_000);
    await started(spice, id);
    expect(await client.cancelFile(id)).toBe(true);
    await expect.poll(async () => (await agentMessages(spice, XFER_STATUS)).some((f) => f.xferId === id && f.result === STATUS.CANCELLED)).toBe(true);
    expect(await last(client, id)).toMatchObject({ state: "cancelled" });
    /* A go-ahead crossing the cancel on the wire finds no transfer. */
    await spice.send("main", "agentFileXferStatus", { id, result: STATUS.CAN_SEND_DATA });
    await client.page.waitForTimeout(200);
    expect(await bytesSent(spice, id)).toBe(0);
    expect(await client.cancelFile(id)).toBe(false);
  });

  test("a chunk being read when the transfer is cancelled is never sent", async ({ client, spice }) => {
    const id = await client.sendFile("x.bin", 1_000_000);
    await client.cancelOnProgress(id);
    await started(spice, id);
    await spice.send("main", "agentFileXferStatus", { id, result: STATUS.CAN_SEND_DATA });
    await expect.poll(async () => (await agentMessages(spice, XFER_STATUS)).some((f) => f.xferId === id && f.result === STATUS.CANCELLED)).toBe(true);
    await client.page.waitForTimeout(300);
    expect((await agentMessages(spice, XFER_DATA)).filter((f) => f.xferId === id)).toHaveLength(1);
    const states = (await client.xfers()).filter((e) => e.id === id).map((e) => e.state);
    expect(states).toEqual(["progress", "cancelled"]);
  });

  test("an agent that leaves fails the transfer", async ({ client, spice }) => {
    const id = await client.sendFile("x.bin", 10);
    await started(spice, id);
    await spice.send("main", "agentDisconnected");
    await expect.poll(() => last(client, id)).toMatchObject({ state: "failed", reason: "agent-gone" });
  });

  test("a main socket that closes on its own fails a transfer in flight", async ({ client, spice }) => {
    /* No stop() from the page: the close alone has to end the transfer. */
    const id = await client.sendFile("x.bin", 50_000_000);
    await started(spice, id);
    await spice.send("main", "agentFileXferStatus", { id, result: STATUS.CAN_SEND_DATA });
    await expect.poll(() => bytesSent(spice, id)).toBeGreaterThan(0);
    await spice.run({ cmd: "close", channel: "main" });
    await expect.poll(() => last(client, id)).toMatchObject({ state: "failed", reason: "disconnected" });
    await client.page.waitForTimeout(300);
    expect(client.pageErrors).toEqual([]);
  });

  test("a file the browser cannot read fails, and the agent is told to drop it", async ({ client, spice }) => {
    await client.page.evaluate(() => {
      /* What a file deleted after it was picked does to the reader. */
      class Failing extends FileReader {
        readAsArrayBuffer() {
          setTimeout(() => this.onerror?.(new ProgressEvent("error")));
        }
      }
      (window as unknown as { FileReader: typeof FileReader }).FileReader = Failing;
    });
    const id = await client.sendFile("gone.bin", 1000);
    await started(spice, id);
    await spice.send("main", "agentFileXferStatus", { id, result: STATUS.CAN_SEND_DATA });
    await expect.poll(() => last(client, id)).toMatchObject({ state: "failed", reason: "unreadable" });
    await expect.poll(async () => (await agentMessages(spice, XFER_STATUS)).some((f) => f.xferId === id && f.result === STATUS.CANCELLED)).toBe(true);
    expect(await bytesSent(spice, id)).toBe(0);
  });

  test("stopping the connection fails a transfer in flight, and nothing throws", async ({ client, spice }) => {
    const id = await client.sendFile("x.bin", 50_000_000);
    await started(spice, id);
    await spice.send("main", "agentFileXferStatus", { id, result: STATUS.CAN_SEND_DATA });
    await expect.poll(() => bytesSent(spice, id)).toBeGreaterThan(0);
    await client.disconnect();
    await expect.poll(() => last(client, id)).toMatchObject({ state: "failed", reason: "disconnected" });
    await client.page.waitForTimeout(300);
    expect(client.pageErrors).toEqual([]);
  });
});

test.describe("file transfer short of agent tokens", () => {
  test("cancelling mid-transfer sends no further chunk", async ({ client, spice }) => {
    /* Ten tokens at connect: the first 64 KiB chunk needs 32 messages, so
       it is still queued when the cancel comes. */
    await spice.reset({ agentConnected: true });
    await client.connectReady({ filexfer: true });
    const id = await client.sendFile("x.bin", 1_000_000);
    await spice.send("main", "agentToken", { tokens: 1 });
    await started(spice, id);
    await spice.send("main", "agentFileXferStatus", { id, result: STATUS.CAN_SEND_DATA });
    await expect.poll(async () => (await agentMessages(spice, XFER_DATA)).length).toBe(1);
    await client.cancelFile(id);
    await spice.send("main", "agentToken", { tokens: 100000 });
    await expect.poll(async () => (await agentMessages(spice, XFER_STATUS)).some((f) => f.xferId === id && f.result === STATUS.CANCELLED)).toBe(true);
    await client.page.waitForTimeout(200);
    expect((await agentMessages(spice, XFER_DATA)).filter((f) => f.xferId === id)).toHaveLength(1);
  });
});
