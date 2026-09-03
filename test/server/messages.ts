/* Server-to-client message builders and client-to-server decoders. Each
   builder returns a complete mini-header message ready for the wire. */
import { C } from "./constants.ts";
import { type Clip, NO_CLIP, type Rect, Reader, Writer, mini } from "./wire.ts";

/* ---------- common ---------- */

export function setAck(generation: number, window: number) {
  return mini(C.SPICE_MSG_SET_ACK, new Writer().u32(generation).u32(window).toBytes());
}

export function ping(id: number, timestamp: number | bigint, extra = 0) {
  const w = new Writer().u32(id).u64(timestamp);
  for (let i = 0; i < extra; i++) w.u8(i & 0xff);
  return mini(C.SPICE_MSG_PING, w.toBytes());
}

export function notify(severity: number, message: string, what = 0, visibility = 0) {
  const text = new TextEncoder().encode(message);
  const w = new Writer().u64(Date.now()).u32(severity).u32(visibility).u32(what).u32(text.length).bytes(text);
  return mini(C.SPICE_MSG_NOTIFY, w.toBytes());
}

export function disconnecting(reason = 0) {
  return mini(C.SPICE_MSG_DISCONNECTING, new Writer().u64(Date.now()).u32(reason).toBytes());
}

/* ---------- main ---------- */

export interface MainInitArgs {
  sessionId: number;
  displayChannelsHint?: number;
  supportedMouseModes?: number;
  currentMouseMode?: number;
  agentConnected?: number;
  agentTokens?: number;
  multiMediaTime: number;
  ramHint?: number;
}

export function mainInit(a: MainInitArgs) {
  const w = new Writer()
    .u32(a.sessionId)
    .u32(a.displayChannelsHint ?? 1)
    .u32(a.supportedMouseModes ?? C.SPICE_MOUSE_MODE_CLIENT | C.SPICE_MOUSE_MODE_SERVER)
    .u32(a.currentMouseMode ?? C.SPICE_MOUSE_MODE_CLIENT)
    .u32(a.agentConnected ?? 0)
    .u32(a.agentTokens ?? 0)
    .u32(a.multiMediaTime)
    .u32(a.ramHint ?? 0);
  return mini(C.SPICE_MSG_MAIN_INIT, w.toBytes());
}

export function channelsList(channels: Array<{ type: number; id: number }>) {
  const w = new Writer().u32(channels.length);
  for (const c of channels) w.u8(c.type).u8(c.id);
  return mini(C.SPICE_MSG_MAIN_CHANNELS_LIST, w.toBytes());
}

export function mouseMode(supported: number, current: number) {
  return mini(C.SPICE_MSG_MAIN_MOUSE_MODE, new Writer().u16(supported).u16(current).toBytes());
}

export function multiMediaTime(time: number) {
  return mini(C.SPICE_MSG_MAIN_MULTI_MEDIA_TIME, new Writer().u32(time).toBytes());
}

export function agentConnectedTokens(tokens: number) {
  return mini(C.SPICE_MSG_MAIN_AGENT_CONNECTED_TOKENS, new Writer().u32(tokens).toBytes());
}

export function agentDisconnected() {
  return mini(C.SPICE_MSG_MAIN_AGENT_DISCONNECTED, new Writer().u32(0).toBytes());
}

export function agentToken(tokens: number) {
  return mini(C.SPICE_MSG_MAIN_AGENT_TOKEN, new Writer().u32(tokens).toBytes());
}

export function agentData(type: number, payload: Uint8Array) {
  const w = new Writer().u32(C.VD_AGENT_PROTOCOL).u32(type).u64(0).u32(payload.length).bytes(payload);
  return mini(C.SPICE_MSG_MAIN_AGENT_DATA, w.toBytes());
}

/* VDAgentAnnounceCapabilities: request u32 + one u32 of caps. */
export function agentAnnounceCapabilities(caps: number, request = 0) {
  return agentData(C.VD_AGENT_ANNOUNCE_CAPABILITIES, new Writer().u32(request).u32(caps).toBytes());
}

/* ---------- display ---------- */

function displayBase(w: Writer, surface: number, box: Rect, clip: Clip) {
  w.u32(surface).rect(box).clip(clip);
}

function qmaskNone(w: Writer) {
  w.u8(0).point(0, 0).u32(0);
}

export interface SurfaceArgs {
  id?: number;
  width: number;
  height: number;
  format?: number;
  primary?: boolean;
}

export function surfaceCreate(a: SurfaceArgs) {
  const w = new Writer()
    .u32(a.id ?? 0)
    .u32(a.width)
    .u32(a.height)
    .u32(a.format ?? C.SPICE_SURFACE_FMT_32_xRGB)
    .u32(a.primary === false ? 0 : C.SPICE_SURFACE_FLAGS_PRIMARY);
  return mini(C.SPICE_MSG_DISPLAY_SURFACE_CREATE, w.toBytes());
}

export function surfaceDestroy(id: number) {
  return mini(C.SPICE_MSG_DISPLAY_SURFACE_DESTROY, new Writer().u32(id).toBytes());
}

export function displayMark() {
  return mini(C.SPICE_MSG_DISPLAY_MARK);
}

export function displayReset() {
  return mini(C.SPICE_MSG_DISPLAY_RESET);
}

export function invalAllPalettes() {
  return mini(C.SPICE_MSG_DISPLAY_INVAL_ALL_PALETTES);
}

export interface DrawFillArgs {
  surface?: number;
  box: Rect;
  clip?: Clip;
  color: number; // 0xRRGGBB
}

export function drawFill(a: DrawFillArgs) {
  const w = new Writer();
  displayBase(w, a.surface ?? 0, a.box, a.clip ?? NO_CLIP);
  w.u8(C.SPICE_BRUSH_TYPE_SOLID).u32(a.color).u16(C.SPICE_ROPD_OP_PUT);
  qmaskNone(w);
  return mini(C.SPICE_MSG_DISPLAY_DRAW_FILL, w.toBytes());
}

/* SpiceCopy with the image placed at the end of the payload, where the
   client's bitmap parser expects it (bitmap.data = mb.slice(at)). */
/* srcArea is the part of the image that lands in the box (default: a box-sized
   rectangle at the image origin); scaleMode is SPICE_IMAGE_SCALE_MODE_*. */
export interface DrawCopyBase {
  surface?: number;
  box: Rect;
  clip?: Clip;
  srcArea?: Rect;
  scaleMode?: number;
}

function drawCopyWith(a: DrawCopyBase, image: (w: Writer) => void) {
  const w = new Writer();
  displayBase(w, a.surface ?? 0, a.box, a.clip ?? NO_CLIP);
  const imageOffset = w.placeholderU32();
  const width = a.box.right - a.box.left;
  const height = a.box.bottom - a.box.top;
  w.rect(a.srcArea ?? { top: 0, left: 0, bottom: height, right: width });
  w.u16(C.SPICE_ROPD_OP_PUT).u8(a.scaleMode ?? 0);
  qmaskNone(w);
  w.patchU32(imageOffset, w.length);
  image(w);
  return mini(C.SPICE_MSG_DISPLAY_DRAW_COPY, w.toBytes());
}

function imageDescriptor(w: Writer, id: number | bigint, type: number, flags: number, width: number, height: number) {
  w.u64(id).u8(type).u8(flags).u32(width).u32(height);
}

export interface BitmapArgs extends DrawCopyBase {
  /* BGRx rows, stride = width * 4. Bottom-up bitmaps carry their rows last-first. */
  pixels: Uint8Array;
  /* Image size when it is not the box size (with srcArea). */
  imageWidth?: number;
  imageHeight?: number;
  topDown?: boolean;
  /* RGBA carries the fourth byte as real alpha; the default 32BIT ignores it. */
  format?: "32bit" | "rgba";
  cacheId?: number;
  cache?: boolean;
}

export function drawCopyBitmap(a: BitmapArgs) {
  const width = a.imageWidth ?? a.box.right - a.box.left;
  const height = a.imageHeight ?? a.box.bottom - a.box.top;
  if (a.pixels.length !== width * height * 4) throw new Error("pixel buffer does not match image size");
  return drawCopyWith(a, (w) => {
    imageDescriptor(w, a.cacheId ?? 0, C.SPICE_IMAGE_TYPE_BITMAP, a.cache ? C.SPICE_IMAGE_FLAGS_CACHE_ME : 0, width, height);
    w.u8(a.format === "rgba" ? C.SPICE_BITMAP_FMT_RGBA : C.SPICE_BITMAP_FMT_32BIT)
      .u8(a.topDown === false ? 0 : C.SPICE_BITMAP_FLAGS_TOP_DOWN)
      .u32(width)
      .u32(height)
      .u32(width * 4)
      .u32(0)
      .bytes(a.pixels);
  });
}

export interface JpegArgs extends DrawCopyBase {
  jpeg: Uint8Array;
  imageWidth?: number;
  imageHeight?: number;
  cacheId?: number;
  cache?: boolean;
}

export function drawCopyJpeg(a: JpegArgs) {
  const width = a.imageWidth ?? a.box.right - a.box.left;
  const height = a.imageHeight ?? a.box.bottom - a.box.top;
  return drawCopyWith(a, (w) => {
    imageDescriptor(w, a.cacheId ?? 0, C.SPICE_IMAGE_TYPE_JPEG, a.cache ? C.SPICE_IMAGE_FLAGS_CACHE_ME : 0, width, height);
    w.u32(a.jpeg.length).bytes(a.jpeg);
  });
}

export function drawCopyFromCache(a: DrawCopyBase & { cacheId: number }) {
  const width = a.box.right - a.box.left;
  const height = a.box.bottom - a.box.top;
  return drawCopyWith(a, (w) => {
    imageDescriptor(w, a.cacheId, C.SPICE_IMAGE_TYPE_FROM_CACHE, 0, width, height);
  });
}

export function drawCopyFromSurface(a: DrawCopyBase & { sourceSurface: number }) {
  const width = a.box.right - a.box.left;
  const height = a.box.bottom - a.box.top;
  return drawCopyWith(a, (w) => {
    imageDescriptor(w, 0, C.SPICE_IMAGE_TYPE_SURFACE, 0, width, height);
    w.u32(a.sourceSurface);
  });
}

export function copyBits(a: { surface?: number; box: Rect; clip?: Clip; src: { x: number; y: number } }) {
  const w = new Writer();
  displayBase(w, a.surface ?? 0, a.box, a.clip ?? NO_CLIP);
  w.point(a.src.x, a.src.y);
  return mini(C.SPICE_MSG_DISPLAY_COPY_BITS, w.toBytes());
}

export interface StreamCreateArgs {
  surface?: number;
  id: number;
  /* SPICE_STREAM_FLAGS_TOP_DOWN is bit 0; a clear bit means the encoder
     emitted rows bottom-first and the client must flip. */
  flags?: number;
  codec?: number;
  width: number;
  height: number;
  srcWidth?: number;
  srcHeight?: number;
  dest: Rect;
  clip?: Clip;
}

export function streamCreate(a: StreamCreateArgs) {
  const w = new Writer()
    .u32(a.surface ?? 0)
    .u32(a.id)
    .u8(a.flags ?? 1)
    .u8(a.codec ?? C.SPICE_VIDEO_CODEC_TYPE_MJPEG)
    .u64(0)
    .u32(a.width)
    .u32(a.height)
    .u32(a.srcWidth ?? a.width)
    .u32(a.srcHeight ?? a.height)
    .rect(a.dest)
    .clip(a.clip ?? NO_CLIP);
  return mini(C.SPICE_MSG_DISPLAY_STREAM_CREATE, w.toBytes());
}

export function streamData(a: { id: number; mmTime: number; data: Uint8Array }) {
  const w = new Writer().u32(a.id).u32(a.mmTime).u32(a.data.length).bytes(a.data);
  return mini(C.SPICE_MSG_DISPLAY_STREAM_DATA, w.toBytes());
}

export function streamDataSized(a: { id: number; mmTime: number; width: number; height: number; dest: Rect; data: Uint8Array }) {
  const w = new Writer().u32(a.id).u32(a.mmTime).u32(a.width).u32(a.height).rect(a.dest).u32(a.data.length).bytes(a.data);
  return mini(C.SPICE_MSG_DISPLAY_STREAM_DATA_SIZED, w.toBytes());
}

export function streamClip(a: { id: number; clip: Clip }) {
  return mini(C.SPICE_MSG_DISPLAY_STREAM_CLIP, new Writer().u32(a.id).clip(a.clip).toBytes());
}

export function streamDestroy(id: number) {
  return mini(C.SPICE_MSG_DISPLAY_STREAM_DESTROY, new Writer().u32(id).toBytes());
}

export function streamDestroyAll() {
  return mini(C.SPICE_MSG_DISPLAY_STREAM_DESTROY_ALL);
}

export function streamActivateReport(a: { id: number; uniqueId?: number; maxWindow?: number; timeoutMs?: number }) {
  const w = new Writer().u32(a.id).u32(a.uniqueId ?? 1).u32(a.maxWindow ?? 5).u32(a.timeoutMs ?? 1000);
  return mini(C.SPICE_MSG_DISPLAY_STREAM_ACTIVATE_REPORT, w.toBytes());
}

export function invalList(ids: Array<number | bigint>) {
  const w = new Writer().u16(ids.length);
  for (const id of ids) w.u8(0).u64(id);
  return mini(C.SPICE_MSG_DISPLAY_INVAL_LIST, w.toBytes());
}

/* ---------- inputs ---------- */

export function inputsInit(modifiers = 0) {
  return mini(C.SPICE_MSG_INPUTS_INIT, new Writer().u16(modifiers).toBytes());
}

export function keyModifiers(modifiers: number) {
  return mini(C.SPICE_MSG_INPUTS_KEY_MODIFIERS, new Writer().u16(modifiers).toBytes());
}

export function mouseMotionAck() {
  return mini(C.SPICE_MSG_INPUTS_MOUSE_MOTION_ACK);
}

/* ---------- cursor ---------- */

export interface CursorShape {
  type?: number;
  width: number;
  height: number;
  hotX?: number;
  hotY?: number;
  unique?: number;
  /* ALPHA cursors carry BGRA pixels; MONO carries AND then XOR 1bpp planes. */
  data: Uint8Array;
}

function cursorBody(w: Writer, shape: CursorShape | null, flags = 0) {
  if (!shape) {
    w.u16(C.SPICE_CURSOR_FLAGS_NONE);
    return;
  }
  w.u16(flags)
    .u64(shape.unique ?? 1)
    .u8(shape.type ?? C.SPICE_CURSOR_TYPE_ALPHA)
    .u16(shape.width)
    .u16(shape.height)
    .u16(shape.hotX ?? 0)
    .u16(shape.hotY ?? 0)
    .bytes(shape.data);
}

export function cursorInit(a: { x?: number; y?: number; visible?: boolean; shape?: CursorShape | null } = {}) {
  const w = new Writer().point16(a.x ?? 0, a.y ?? 0).u16(0).u16(0).u8(a.visible === false ? 0 : 1);
  cursorBody(w, a.shape ?? null);
  return mini(C.SPICE_MSG_CURSOR_INIT, w.toBytes());
}

export function cursorSet(a: { x?: number; y?: number; visible?: boolean; shape: CursorShape | null }) {
  const w = new Writer().point16(a.x ?? 0, a.y ?? 0).u8(a.visible === false ? 0 : 1);
  cursorBody(w, a.shape);
  return mini(C.SPICE_MSG_CURSOR_SET, w.toBytes());
}

export function cursorMove(x: number, y: number) {
  return mini(C.SPICE_MSG_CURSOR_MOVE, new Writer().point16(x, y).toBytes());
}

export function cursorHide() {
  return mini(C.SPICE_MSG_CURSOR_HIDE);
}

export function cursorReset() {
  return mini(C.SPICE_MSG_CURSOR_RESET);
}

/* ---------- playback ---------- */

export function playbackStart(a: { channels?: number; frequency?: number; time: number }) {
  const w = new Writer().u32(a.channels ?? 2).u16(C.SPICE_AUDIO_FMT_S16).u32(a.frequency ?? 48000).u32(a.time);
  return mini(C.SPICE_MSG_PLAYBACK_START, w.toBytes());
}

export function playbackMode(a: { time: number; mode?: number }) {
  return mini(C.SPICE_MSG_PLAYBACK_MODE, new Writer().u32(a.time).u16(a.mode ?? C.SPICE_AUDIO_DATA_MODE_OPUS).toBytes());
}

export function playbackData(a: { time: number; data: Uint8Array }) {
  return mini(C.SPICE_MSG_PLAYBACK_DATA, new Writer().u32(a.time).bytes(a.data).toBytes());
}

export function playbackStop() {
  return mini(C.SPICE_MSG_PLAYBACK_STOP);
}

/* ---------- client -> server decoding ---------- */

export interface ClientMessage {
  type: number;
  name: string;
  fields: Record<string, unknown>;
  size: number;
}

const COMMON: Record<number, string> = {
  [C.SPICE_MSGC_ACK_SYNC]: "ack_sync",
  [C.SPICE_MSGC_ACK]: "ack",
  [C.SPICE_MSGC_PONG]: "pong",
  [C.SPICE_MSGC_DISCONNECTING]: "disconnecting",
};

const BY_CHANNEL: Record<number, Record<number, string>> = {
  [C.SPICE_CHANNEL_MAIN]: {
    [C.SPICE_MSGC_MAIN_ATTACH_CHANNELS]: "attach_channels",
    [C.SPICE_MSGC_MAIN_MOUSE_MODE_REQUEST]: "mouse_mode_request",
    [C.SPICE_MSGC_MAIN_AGENT_START]: "agent_start",
    [C.SPICE_MSGC_MAIN_AGENT_DATA]: "agent_data",
    [C.SPICE_MSGC_MAIN_AGENT_TOKEN]: "agent_token",
  },
  [C.SPICE_CHANNEL_DISPLAY]: {
    [C.SPICE_MSGC_DISPLAY_INIT]: "display_init",
    [C.SPICE_MSGC_DISPLAY_STREAM_REPORT]: "stream_report",
    [C.SPICE_MSGC_DISPLAY_PREFERRED_VIDEO_CODEC_TYPE]: "preferred_video_codec_type",
  },
  [C.SPICE_CHANNEL_INPUTS]: {
    [C.SPICE_MSGC_INPUTS_KEY_DOWN]: "key_down",
    [C.SPICE_MSGC_INPUTS_KEY_UP]: "key_up",
    [C.SPICE_MSGC_INPUTS_KEY_MODIFIERS]: "key_modifiers",
    [C.SPICE_MSGC_INPUTS_MOUSE_MOTION]: "mouse_motion",
    [C.SPICE_MSGC_INPUTS_MOUSE_POSITION]: "mouse_position",
    [C.SPICE_MSGC_INPUTS_MOUSE_PRESS]: "mouse_press",
    [C.SPICE_MSGC_INPUTS_MOUSE_RELEASE]: "mouse_release",
  },
  [C.SPICE_CHANNEL_RECORD]: {
    [C.SPICE_MSGC_RECORD_DATA]: "record_data",
    [C.SPICE_MSGC_RECORD_MODE]: "record_mode",
    [C.SPICE_MSGC_RECORD_START_MARK]: "record_start_mark",
  },
};

export function decodeClient(channelType: number, type: number, data: Uint8Array): ClientMessage {
  const name = COMMON[type] ?? BY_CHANNEL[channelType]?.[type] ?? `type${type}`;
  const r = new Reader(data);
  const fields: Record<string, unknown> = {};
  switch (name) {
    case "ack_sync":
      fields.generation = r.u32();
      break;
    case "pong":
      fields.id = r.u32();
      fields.timestamp = Number(r.u64());
      break;
    case "mouse_mode_request":
      fields.mode = r.u16();
      break;
    case "agent_start":
      fields.tokens = r.u32();
      break;
    case "agent_data":
      /* The client splits agent messages into VD_AGENT_MAX_DATA_SIZE chunks;
         only the first carries the VDAgentMessage header. A chunk shorter
         than the header (or a continuation) is recorded as raw bytes. */
      if (r.remaining < 20) {
        fields.continuation = true;
        fields.data = Array.from(r.rest());
        break;
      }
      fields.protocol = r.u32();
      fields.agentType = r.u32();
      fields.opaque = Number(r.u64());
      fields.size = r.u32();
      fields.data = Array.from(r.rest());
      break;
    case "agent_token":
      fields.tokens = r.u32();
      break;
    case "display_init":
      fields.pixmapCacheId = r.u8();
      fields.pixmapCacheSize = Number(r.u64());
      fields.glzDictionaryId = r.u8();
      fields.glzWindowSize = r.u32();
      break;
    case "preferred_video_codec_type": {
      const n = r.u8();
      const codecs: number[] = [];
      for (let i = 0; i < n; i++) codecs.push(r.u8());
      fields.codecs = codecs;
      break;
    }
    case "stream_report":
      fields.streamId = r.u32();
      fields.uniqueId = r.u32();
      fields.startFrameMmTime = r.u32();
      fields.endFrameMmTime = r.u32();
      fields.numFrames = r.u32();
      fields.numDrops = r.u32();
      fields.lastFrameDelay = r.u32() | 0;
      fields.audioDelay = r.u32() | 0;
      break;
    case "key_down":
    case "key_up":
      fields.code = r.u32();
      break;
    case "key_modifiers":
      fields.modifiers = r.u16();
      break;
    case "mouse_motion":
    case "mouse_position":
      fields.x = r.u32() | 0;
      fields.y = r.u32() | 0;
      fields.buttonsState = r.u16();
      fields.displayId = r.u8();
      break;
    case "mouse_press":
    case "mouse_release":
      fields.button = r.u8();
      fields.buttonsState = r.u16();
      break;
    case "record_mode":
      fields.time = r.u32();
      fields.mode = r.u16();
      break;
    case "record_start_mark":
      fields.time = r.u32();
      break;
    case "record_data":
      fields.time = r.u32();
      fields.bytes = r.remaining;
      break;
  }
  return { type, name, fields, size: data.length };
}
