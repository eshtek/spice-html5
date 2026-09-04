"use strict";
/*
 *   Copyright (C) 2026 by Eshtek, Inc.
 *
 *   This file is part of spice-html5.
 *
 *   spice-html5 is free software: you can redistribute it and/or modify
 *   it under the terms of the GNU Lesser General Public License as published by
 *   the Free Software Foundation, either version 3 of the License, or
 *   (at your option) any later version.
 *
 *   spice-html5 is distributed in the hope that it will be useful,
 *   but WITHOUT ANY WARRANTY; without even the implied warranty of
 *   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *   GNU Lesser General Public License for more details.
 *
 *   You should have received a copy of the GNU Lesser General Public License
 *   along with spice-html5.  If not, see <http://www.gnu.org/licenses/>.
 */

/*----------------------------------------------------------------------------
**  lz4.js
**      SPICE_IMAGE_TYPE_LZ4: a two byte header (top_down, bitmap format)
**  followed by LZ4 blocks, each behind a big-endian byte count.  The
**  server compresses the blocks as one stream, so a match may reach back
**  into an earlier block's output; decoding every block into one buffer
**  makes that the ordinary case rather than a special one.
**--------------------------------------------------------------------------*/

import { Constants } from './enums.js';
import { convert_spice_bitmap_to_web } from './bitmap.js';

/* One raw LZ4 block, src[sp, send), appended at dst[dp].  Returns the new
   dp, or -1 for malformed input: a literal or match running past either
   buffer, an offset reaching before the start of dst, or a count that
   ends early. */
function lz4_block_decode(src, sp, send, dst, dp)
{
    var dend = dst.length;
    var i, b;
    while (sp < send)
    {
        var token = src[sp++];
        var lit = token >>> 4;
        if (lit == 15)
        {
            do {
                if (sp >= send)
                    return -1;
                b = src[sp++];
                lit += b;
            } while (b == 255);
        }
        if (sp + lit > send || dp + lit > dend)
            return -1;
        if (lit > 16)
            dst.set(src.subarray(sp, sp + lit), dp);
        else
            for (i = 0; i < lit; i++)
                dst[dp + i] = src[sp + i];
        sp += lit;
        dp += lit;

        /* The last sequence of a block is literals only. */
        if (sp >= send)
            break;
        if (sp + 2 > send)
            return -1;
        var offset = src[sp] | (src[sp + 1] << 8);
        sp += 2;
        if (offset == 0 || offset > dp)
            return -1;
        var mlen = (token & 15) + 4;
        if ((token & 15) == 15)
        {
            do {
                if (sp >= send)
                    return -1;
                b = src[sp++];
                mlen += b;
            } while (b == 255);
        }
        if (dp + mlen > dend)
            return -1;
        var ref = dp - offset;
        /* An overlapping match repeats the bytes it is producing, so the
           byte loop is the only correct copy there. */
        if (offset >= mlen && mlen > 16)
            dst.copyWithin(dp, ref, ref + mlen);
        else
            for (i = 0; i < mlen; i++)
                dst[dp + i] = dst[ref + i];
        dp += mlen;
    }
    return dp;
}

function bytes_per_pixel(format)
{
    switch (format)
    {
        case Constants.SPICE_BITMAP_FMT_16BIT:
            return 2;
        case Constants.SPICE_BITMAP_FMT_24BIT:
            return 3;
        case Constants.SPICE_BITMAP_FMT_32BIT:
        case Constants.SPICE_BITMAP_FMT_RGBA:
            return 4;
    }
    return 0;
}

/* The image as a SpiceBitmap-shaped object (format, flags, x, y, stride,
   data), or undefined when the data is malformed or the format is not
   one the server's encoder produces.  The encoder only takes bitmaps
   without stride padding, so the rows are packed. */
function decode_spice_lz4(descriptor, lz4)
{
    var u8 = new Uint8Array(lz4.data);
    if (u8.length < 2)
        return undefined;
    var top_down = u8[0];
    var format = u8[1];
    var bpp = bytes_per_pixel(format);
    if (! bpp)
        return undefined;

    var w = descriptor.width;
    var h = descriptor.height;
    var stride = w * bpp;
    var out = new Uint8Array(h * stride);
    var sp = 2;
    var dp = 0;
    while (sp < u8.length)
    {
        if (sp + 4 > u8.length)
            return undefined;
        var n = ((u8[sp] << 24) | (u8[sp + 1] << 16) | (u8[sp + 2] << 8) | u8[sp + 3]) >>> 0;
        sp += 4;
        if (sp + n > u8.length)
            return undefined;
        dp = lz4_block_decode(u8, sp, sp + n, out, dp);
        if (dp < 0)
            return undefined;
        sp += n;
    }
    if (dp != out.length)
        return undefined;

    return { format: format,
             flags: top_down ? Constants.SPICE_BITMAP_FLAGS_TOP_DOWN : 0,
             x: w, y: h, stride: stride, data: out.buffer };
}

function convert_spice_lz4_to_web(context, descriptor, lz4)
{
    var bitmap = decode_spice_lz4(descriptor, lz4);
    if (! bitmap)
        return undefined;
    if (bitmap.format == Constants.SPICE_BITMAP_FMT_32BIT ||
        bitmap.format == Constants.SPICE_BITMAP_FMT_RGBA)
        return convert_spice_bitmap_to_web(context, bitmap);

    /* 24BIT is packed BGR; 16BIT is x1r5g5b5 in little-endian words. */
    var w = bitmap.x;
    var h = bitmap.y;
    var top_down = bitmap.flags & Constants.SPICE_BITMAP_FLAGS_TOP_DOWN;
    var ret = context.createImageData(w, h);
    var out = ret.data;
    var src = new Uint8Array(bitmap.data);
    var o = 0;
    for (var y = 0; y < h; y++)
    {
        var s = (top_down ? y : h - 1 - y) * bitmap.stride;
        if (bitmap.format == Constants.SPICE_BITMAP_FMT_24BIT)
        {
            for (var x = 0; x < w; x++, o += 4, s += 3)
            {
                out[o + 0] = src[s + 2];
                out[o + 1] = src[s + 1];
                out[o + 2] = src[s + 0];
                out[o + 3] = 255;
            }
        }
        else
        {
            for (x = 0; x < w; x++, o += 4, s += 2)
            {
                var v = src[s] | (src[s + 1] << 8);
                var r = (v >> 10) & 31;
                var g = (v >> 5) & 31;
                var b = v & 31;
                out[o + 0] = (r << 3) | (r >> 2);
                out[o + 1] = (g << 3) | (g >> 2);
                out[o + 2] = (b << 3) | (b >> 2);
                out[o + 3] = 255;
            }
        }
    }
    return ret;
}

export {
  lz4_block_decode,
  decode_spice_lz4,
  convert_spice_lz4_to_web,
};
