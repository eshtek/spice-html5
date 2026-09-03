import type { FakeSpiceServer, Step } from "../server.ts";

/* A 640x480 primary surface with a grey backdrop and a quadrant logo. */
export const steps = (_server: FakeSpiceServer): Step[] => [
  { cmd: "send", channel: "display", msg: "surfaceCreate", args: { width: 640, height: 480 } },
  { cmd: "send", channel: "display", msg: "drawFill", args: { box: { left: 0, top: 0, right: 640, bottom: 480 }, color: 0x203040 } },
  {
    cmd: "send",
    channel: "display",
    msg: "drawCopyBitmap",
    args: { box: { left: 64, top: 64, right: 192, bottom: 192 }, image: { kind: "quadrants", width: 128, height: 128 } },
  },
];
