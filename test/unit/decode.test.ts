/* Client-to-server decoding checked against messages the client builds. */
import { expect, test } from "bun:test";
import { C } from "../server/constants.ts";
import { decodeClient } from "../server/messages.ts";
import {
  SpiceMiniData,
  SpiceMsgcDisplayInit,
  SpiceMsgcDisplayStreamReport,
  SpiceMsgcKeyDown,
  SpiceMsgcMainMouseModeRequest,
  SpiceMsgcMousePosition,
  SpiceMsgcMousePress,
} from "../../src/spicemsg.js";

function viaWire(channel: number, type: number, body: { buffer_size(): number; to_buffer(a: ArrayBuffer): void }) {
  const mini = new SpiceMiniData();
  mini.build_msg(type, body);
  const ab = new ArrayBuffer(mini.buffer_size());
  mini.to_buffer(ab);
  const u8 = new Uint8Array(ab);
  const dv = new DataView(ab);
  return decodeClient(channel, dv.getUint16(0, true), u8.subarray(6));
}

test("key down", () => {
  const k = new SpiceMsgcKeyDown();
  k.code = 0x5be0;
  const m = viaWire(C.SPICE_CHANNEL_INPUTS, C.SPICE_MSGC_INPUTS_KEY_DOWN, k);
  expect(m.name).toBe("key_down");
  expect(m.fields.code).toBe(0x5be0);
});

test("mouse position and press", () => {
  const pos = new SpiceMsgcMousePosition({ buttons_state: 0 }, { offsetX: 120, offsetY: 45 });
  const m = viaWire(C.SPICE_CHANNEL_INPUTS, C.SPICE_MSGC_INPUTS_MOUSE_POSITION, pos);
  expect(m.name).toBe("mouse_position");
  expect(m.fields).toMatchObject({ x: 120, y: 45, buttonsState: 0, displayId: 0 });

  const press = new SpiceMsgcMousePress({}, { button: 2 });
  const p = viaWire(C.SPICE_CHANNEL_INPUTS, C.SPICE_MSGC_INPUTS_MOUSE_PRESS, press);
  expect(p.fields).toMatchObject({ button: 3, buttonsState: 4 });
});

test("display init", () => {
  const m = viaWire(C.SPICE_CHANNEL_DISPLAY, C.SPICE_MSGC_DISPLAY_INIT, new SpiceMsgcDisplayInit());
  expect(m.name).toBe("display_init");
  expect(m.fields.pixmapCacheSize).toBe(10 * 1024 * 1024);
});

test("stream report", () => {
  const r = new SpiceMsgcDisplayStreamReport(4, 9);
  r.num_frames = 12;
  r.num_drops = 2;
  r.last_frame_delay = -30;
  const m = viaWire(C.SPICE_CHANNEL_DISPLAY, C.SPICE_MSGC_DISPLAY_STREAM_REPORT, r);
  expect(m.fields).toMatchObject({ streamId: 4, uniqueId: 9, numFrames: 12, numDrops: 2, lastFrameDelay: -30, audioDelay: -1 });
});

test("mouse mode request", () => {
  const m = viaWire(C.SPICE_CHANNEL_MAIN, C.SPICE_MSGC_MAIN_MOUSE_MODE_REQUEST, new SpiceMsgcMainMouseModeRequest(C.SPICE_MOUSE_MODE_CLIENT));
  expect(m.fields.mode).toBe(C.SPICE_MOUSE_MODE_CLIENT);
});

test("unknown types are named by number", () => {
  expect(decodeClient(C.SPICE_CHANNEL_MAIN, 250, new Uint8Array(0)).name).toBe("type250");
});
