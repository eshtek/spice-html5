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

function convert_spice_bitmap_to_web(context, spice_bitmap)
{
    var ret;
    var offset, x, src_offset = 0, src_dec = 0;
    var u8 = new Uint8Array(spice_bitmap.data);
    if (spice_bitmap.format != Constants.SPICE_BITMAP_FMT_32BIT &&
        spice_bitmap.format != Constants.SPICE_BITMAP_FMT_RGBA)
        return undefined;

    if (!(spice_bitmap.flags & Constants.SPICE_BITMAP_FLAGS_TOP_DOWN))
    {
        src_offset = (spice_bitmap.y - 1 ) * spice_bitmap.stride;
        src_dec = 2 * spice_bitmap.stride;
    }

    ret = context.createImageData(spice_bitmap.x, spice_bitmap.y);
    var dest = ret.data;
    var end = spice_bitmap.y * spice_bitmap.stride;
    var w = spice_bitmap.x;
    // FIXME - We effectively treat all images as having SPICE_IMAGE_FLAGS_HIGH_BITS_SET
    var opaque = spice_bitmap.format == Constants.SPICE_BITMAP_FMT_32BIT;
    for (offset = 0; offset < end; src_offset -= src_dec)
        for (x = 0; x < w; x++, offset += 4, src_offset += 4)
        {
            dest[offset + 0 ] = u8[src_offset + 2];
            dest[offset + 1 ] = u8[src_offset + 1];
            dest[offset + 2 ] = u8[src_offset + 0];
            dest[offset + 3 ] = opaque ? 255 : u8[src_offset];
        }

    return ret;
}

export {
  convert_spice_bitmap_to_web,
};
