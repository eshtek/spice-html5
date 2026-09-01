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
**  SpiceDataView
**    Historically a byte-at-a-time reimplementation for browsers without
**    DataView.  Now backed by the native DataView (much faster for message
**    parsing); the u8 view is kept because callers subarray() it directly.
**--------------------------------------------------------------------------*/
function SpiceDataView(buffer, byteOffset, byteLength)
{
    if (byteOffset !== undefined)
    {
        if (byteLength !== undefined)
            this.u8 = new Uint8Array(buffer, byteOffset, byteLength);
        else
            this.u8 = new Uint8Array(buffer, byteOffset);
    }
    else
        this.u8 = new Uint8Array(buffer);
    this.dv = new DataView(this.u8.buffer, this.u8.byteOffset, this.u8.byteLength);
};

SpiceDataView.prototype = {
    getUint8:  function(byteOffset)
    {
        return this.u8[byteOffset];
    },
    getUint16:  function(byteOffset, littleEndian)
    {
        return this.dv.getUint16(byteOffset, littleEndian);
    },
    getUint32:  function(byteOffset, littleEndian)
    {
        return this.dv.getUint32(byteOffset, littleEndian);
    },
    getUint64: function (byteOffset, littleEndian)
    {
        /* Values above 2^53 still lose precision in a Number. */
        return Number(this.dv.getBigUint64(byteOffset, littleEndian));
    },
    setUint8:  function(byteOffset, b)
    {
        this.u8[byteOffset] = (b & 0xff);
    },
    setUint16:  function(byteOffset, i, littleEndian)
    {
        this.dv.setUint16(byteOffset, i, littleEndian);
    },
    setUint32:  function(byteOffset, w, littleEndian)
    {
        this.dv.setUint32(byteOffset, w >>> 0, littleEndian);
    },
    setUint64:  function(byteOffset, w, littleEndian)
    {
        this.dv.setBigUint64(byteOffset, BigInt(w), littleEndian);
    },
}

export {
  SpiceDataView,
};
