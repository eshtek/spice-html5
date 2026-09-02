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

/* A 32-bit source pixel read as one little-endian word is B | G<<8 | R<<16 |
   A<<24; the ImageData word wants R | G<<8 | B<<16 | A<<24, so the swap is
   one load, one store and a few shifts per pixel instead of four byte
   copies. Only 32BIT and RGBA are handled; 32BIT ignores the source's
   high byte and is fully opaque. */
function convert_spice_bitmap_to_web(context, spice_bitmap)
{
    var x, y;
    if (spice_bitmap.format != Constants.SPICE_BITMAP_FMT_32BIT &&
        spice_bitmap.format != Constants.SPICE_BITMAP_FMT_RGBA)
        return undefined;

    var w = spice_bitmap.x;
    var h = spice_bitmap.y;
    var stride = spice_bitmap.stride;
    var ret = context.createImageData(w, h);
    var opaque = spice_bitmap.format == Constants.SPICE_BITMAP_FMT_32BIT;
    var top_down = spice_bitmap.flags & Constants.SPICE_BITMAP_FLAGS_TOP_DOWN;
    var keep = opaque ? 0 : 0xff000000;
    var set = opaque ? 0xff000000 : 0;
    var src = word_view(spice_bitmap.data, h * stride);
    if (src && (stride & 3) == 0)
    {
        var dest = new Uint32Array(ret.data.buffer);
        var src_stride = stride >> 2;
        var d = 0;
        for (y = 0; y < h; y++)
        {
            var s = (top_down ? y : h - 1 - y) * src_stride;
            for (x = 0; x < w; x++, d++, s++)
            {
                var v = src[s];
                dest[d] = ((v >>> 16) & 0xff) | (v & 0xff00) | ((v & 0xff) << 16) | (v & keep) | set;
            }
        }
        return ret;
    }

    /* Unaligned source: byte at a time. */
    var u8 = new Uint8Array(spice_bitmap.data);
    var out = ret.data;
    var offset = 0;
    for (y = 0; y < h; y++)
    {
        var src_offset = (top_down ? y : h - 1 - y) * stride;
        for (x = 0; x < w; x++, offset += 4, src_offset += 4)
        {
            out[offset + 0] = u8[src_offset + 2];
            out[offset + 1] = u8[src_offset + 1];
            out[offset + 2] = u8[src_offset + 0];
            out[offset + 3] = opaque ? 255 : u8[src_offset + 3];
        }
    }
    return ret;
}

/* A Uint32Array over the first `bytes` of an ArrayBuffer or typed-array
   view, or undefined when the start is not word aligned. */
function word_view(data, bytes)
{
    var buffer = data instanceof ArrayBuffer ? data : data.buffer;
    var offset = data instanceof ArrayBuffer ? 0 : data.byteOffset;
    var avail = data.byteLength;
    if ((offset & 3) != 0 || avail < bytes)
        return undefined;
    return new Uint32Array(buffer, offset, bytes >> 2);
}

export {
  convert_spice_bitmap_to_web,
};
