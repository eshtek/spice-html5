"use strict";
/*
   Copyright (C) 2012 by Jeremy P. White <jwhite@codeweavers.com>

   This file is part of spice-html5.

   spice-html5 is free software: you can redistribute it and/or modify
   it under the terms of the GNU Lesser General Public License as published by
   the Free Software Foundation, either version 3 of the License, or
   (at your option) any later version.

   spice-html5 is distributed in the hope that it will be useful,
   but WITHOUT ANY WARRANTY; without even the implied warranty of
   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
   GNU Lesser General Public License for more details.

   You should have received a copy of the GNU Lesser General Public License
   along with spice-html5.  If not, see <http://www.gnu.org/licenses/>.
*/


/*----------------------------------------------------------------------------
**  bitmap.js
**      Handle SPICE_IMAGE_TYPE_BITMAP
**--------------------------------------------------------------------------*/

import { Constants } from './enums.js';

/* A 32-bit source pixel is B, G, R, A in memory. Read it as a little-endian
   word, A R G B, rotate it left by eight to R G B A and store that word
   big-endian, so the bytes land in the R, G, B, A order ImageData wants: one
   load, one store and two shifts per pixel. A DataView takes either host
   byte order and any alignment. Only 32BIT and RGBA are handled; 32BIT
   ignores the source's high byte and is fully opaque. */
function convert_spice_bitmap_to_web(context, spice_bitmap, palette)
{
    if (spice_bitmap.format != Constants.SPICE_BITMAP_FMT_32BIT &&
        spice_bitmap.format != Constants.SPICE_BITMAP_FMT_RGBA)
        return convert_other_bitmap_to_web(context, spice_bitmap, palette);

    const w = spice_bitmap.x;
    const h = spice_bitmap.y;
    const stride = spice_bitmap.stride;
    const ret = context.createImageData(w, h);
    const opaque = spice_bitmap.format == Constants.SPICE_BITMAP_FMT_32BIT;
    const top_down = spice_bitmap.flags & Constants.SPICE_BITMAP_FLAGS_TOP_DOWN;
    const src = new DataView(spice_bitmap.data);
    const dest = new DataView(ret.data.buffer);
    let d = 0;
    for (let y = 0; y < h; y++)
    {
        let s = (top_down ? y : h - 1 - y) * stride;
        for (let x = 0; x < w; x++, d += 4, s += 4)
        {
            const v = src.getUint32(s, true);
            dest.setUint32(d, (v << 8) | (opaque ? 0xff : v >>> 24), false);
        }
    }
    return ret;
}

/* The palettised, 16 and 24 bit formats and A8, a pixel at a time.
   Palette entries are packed xRGB; 1BIT and 4BIT come most significant
   bit or high nibble first in the BE forms and the other way round in
   the LE forms; 16BIT is x1r5g5b5; 24BIT is packed BGR; 8BIT_A is
   alpha alone.  Without a palette a palettised bitmap cannot be drawn. */
function convert_other_bitmap_to_web(context, spice_bitmap, palette)
{
    var format = spice_bitmap.format;
    var w = spice_bitmap.x;
    var h = spice_bitmap.y;
    var stride = spice_bitmap.stride;
    var top_down = spice_bitmap.flags & Constants.SPICE_BITMAP_FLAGS_TOP_DOWN;
    var u8 = new Uint8Array(spice_bitmap.data);
    var palettised = format == Constants.SPICE_BITMAP_FMT_1BIT_LE || format == Constants.SPICE_BITMAP_FMT_1BIT_BE ||
                     format == Constants.SPICE_BITMAP_FMT_4BIT_LE || format == Constants.SPICE_BITMAP_FMT_4BIT_BE ||
                     format == Constants.SPICE_BITMAP_FMT_8BIT;
    if (palettised && ! palette)
        return undefined;
    if (! palettised && format != Constants.SPICE_BITMAP_FMT_16BIT &&
        format != Constants.SPICE_BITMAP_FMT_24BIT && format != Constants.SPICE_BITMAP_FMT_8BIT_A)
        return undefined;
    var ret = context.createImageData(w, h);
    var out = ret.data;
    var o = 0;
    for (var y = 0; y < h; y++)
    {
        var row = (top_down ? y : h - 1 - y) * stride;
        for (var x = 0; x < w; x++, o += 4)
        {
            var e, b, a = 255;
            switch (format)
            {
                case Constants.SPICE_BITMAP_FMT_1BIT_LE:
                    e = palette[(u8[row + (x >> 3)] >> (x & 7)) & 1];
                    break;
                case Constants.SPICE_BITMAP_FMT_1BIT_BE:
                    e = palette[(u8[row + (x >> 3)] >> (7 - (x & 7))) & 1];
                    break;
                case Constants.SPICE_BITMAP_FMT_4BIT_LE:
                    b = u8[row + (x >> 1)];
                    e = palette[(x & 1) ? (b >> 4) : (b & 15)];
                    break;
                case Constants.SPICE_BITMAP_FMT_4BIT_BE:
                    b = u8[row + (x >> 1)];
                    e = palette[(x & 1) ? (b & 15) : (b >> 4)];
                    break;
                case Constants.SPICE_BITMAP_FMT_8BIT:
                    e = palette[u8[row + x]];
                    break;
                case Constants.SPICE_BITMAP_FMT_16BIT:
                    var v = u8[row + x * 2] | (u8[row + x * 2 + 1] << 8);
                    var r5 = (v >> 10) & 31, g5 = (v >> 5) & 31, b5 = v & 31;
                    e = ((r5 << 3) | (r5 >> 2)) << 16 | ((g5 << 3) | (g5 >> 2)) << 8 | ((b5 << 3) | (b5 >> 2));
                    break;
                case Constants.SPICE_BITMAP_FMT_24BIT:
                    e = (u8[row + x * 3 + 2] << 16) | (u8[row + x * 3 + 1] << 8) | u8[row + x * 3];
                    break;
                default: /* 8BIT_A */
                    e = 0;
                    a = u8[row + x];
            }
            if (e === undefined)
                e = 0;
            out[o] = (e >> 16) & 0xff;
            out[o + 1] = (e >> 8) & 0xff;
            out[o + 2] = e & 0xff;
            out[o + 3] = a;
        }
    }
    return ret;
}

/* A 1-bit mask bitmap as one byte per pixel, 1 where an op may draw,
   rows top-down; undefined for any other format. */
function convert_spice_mask(spice_bitmap, invers)
{
    var format = spice_bitmap.format;
    if (format != Constants.SPICE_BITMAP_FMT_1BIT_LE && format != Constants.SPICE_BITMAP_FMT_1BIT_BE)
        return undefined;
    var w = spice_bitmap.x;
    var h = spice_bitmap.y;
    var stride = spice_bitmap.stride;
    var top_down = spice_bitmap.flags & Constants.SPICE_BITMAP_FLAGS_TOP_DOWN;
    var u8 = new Uint8Array(spice_bitmap.data);
    var bits = new Uint8Array(w * h);
    var be = format == Constants.SPICE_BITMAP_FMT_1BIT_BE;
    for (var y = 0; y < h; y++)
    {
        var row = (top_down ? y : h - 1 - y) * stride;
        for (var x = 0; x < w; x++)
        {
            var bit = (u8[row + (x >> 3)] >> (be ? 7 - (x & 7) : (x & 7))) & 1;
            bits[y * w + x] = invers ? bit ^ 1 : bit;
        }
    }
    return { bits: bits, width: w, height: h };
}

export {
  convert_spice_bitmap_to_web,
  convert_spice_mask,
};
