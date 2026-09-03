/* The client's own enum table is the source of truth for every wire value
   the fake server emits; duplicating it here would let the two drift. */
import { Constants as raw } from "../../src/enums.js";

export const C = raw as unknown as Record<string, number>;

export const CHANNEL_NAMES: Record<number, string> = {
  [C.SPICE_CHANNEL_MAIN]: "main",
  [C.SPICE_CHANNEL_DISPLAY]: "display",
  [C.SPICE_CHANNEL_INPUTS]: "inputs",
  [C.SPICE_CHANNEL_CURSOR]: "cursor",
  [C.SPICE_CHANNEL_PLAYBACK]: "playback",
  [C.SPICE_CHANNEL_RECORD]: "record",
  [C.SPICE_CHANNEL_PORT]: "port",
};

export const CHANNEL_TYPES: Record<string, number> = Object.fromEntries(
  Object.entries(CHANNEL_NAMES).map(([k, v]) => [v, Number(k)]),
);

export function channelName(type: number): string {
  return CHANNEL_NAMES[type] ?? `channel${type}`;
}
