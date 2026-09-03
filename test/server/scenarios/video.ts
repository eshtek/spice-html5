import type { FakeSpiceServer, Step } from "../server.ts";

/* Desktop plus a looping MJPEG stream, for eyeballing in a browser. */
export const steps = (_server: FakeSpiceServer): Step[] => [
  { cmd: "send", channel: "display", msg: "surfaceCreate", args: { width: 640, height: 480 } },
  { cmd: "send", channel: "display", msg: "drawFill", args: { box: { left: 0, top: 0, right: 640, bottom: 480 }, color: 0x203040 } },
  { cmd: "stream", args: { id: 0, frames: 600, fps: 24, width: 320, height: 240, dest: { left: 160, top: 120 }, destroy: true } },
];
