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
**  Spice types
**      This file contains classes for common spice types.
**  Generally, they are used as helpers in reading and writing messages
**  to and from the server.
**--------------------------------------------------------------------------*/

import { Constants } from './enums.js';
import { SpiceQuic } from './quic.js';

function SpiceChannelId()
{
}
SpiceChannelId.prototype =
{
    from_dv: function(dv, at, mb)
    {
        this.type = dv.getUint8(at, true); at ++;
        this.id = dv.getUint8(at, true); at ++;
        return at;
    },
}

function SpiceRect()
{
}

SpiceRect.prototype =
{
    from_dv: function(dv, at, mb)
    {
        this.top = dv.getUint32(at, true); at += 4;
        this.left = dv.getUint32(at, true); at += 4;
        this.bottom = dv.getUint32(at, true); at += 4;
        this.right = dv.getUint32(at, true); at += 4;
        return at;
    },
    is_same_size : function(r)
    {
        if ((this.bottom - this.top) == (r.bottom - r.top) &&
            (this.right - this.left) == (r.right - r.left) )
            return true;

        return false;
    },
}

function SpiceClipRects()
{
}

SpiceClipRects.prototype =
{
    from_dv: function(dv, at, mb)
    {
        var i;
        this.num_rects = dv.getUint32(at, true); at += 4;
        if (this.num_rects > 0)
            this.rects = [];
        for (i = 0; i < this.num_rects; i++)
        {
            this.rects[i] = new SpiceRect();
            at = this.rects[i].from_dv(dv, at, mb);
        }
        return at;
    },
}

function SpiceClip()
{
}

SpiceClip.prototype =
{
    from_dv: function(dv, at, mb)
    {
        this.type = dv.getUint8(at, true); at ++;
        if (this.type == Constants.SPICE_CLIP_TYPE_RECTS)
        {
            this.rects = new SpiceClipRects();
            at = this.rects.from_dv(dv, at, mb);
        }
        return at;
    },
}

function SpiceImageDescriptor()
{
}

SpiceImageDescriptor.prototype =
{
    from_dv: function(dv, at, mb)
    {
        this.id = dv.getBigUint64(at, true); at += 8;
        this.type  = dv.getUint8(at, true); at ++;
        this.flags = dv.getUint8(at, true); at ++;
        this.width = dv.getUint32(at, true); at += 4;
        this.height= dv.getUint32(at, true); at += 4;
        return at;
    },
}

function SpicePalette()
{
}

SpicePalette.prototype =
{
    from_dv: function(dv, at, mb)
    {
        var i;
        this.unique = dv.getBigUint64(at, true); at += 8;
        this.num_ents = dv.getUint16(at, true); at += 2;
        this.ents = [];
        for (i = 0; i < this.num_ents; i++)
        {
            this.ents[i] = dv.getUint32(at, true); at += 4;
        }
        return at;
    },
}

function SpiceBitmap()
{
}

SpiceBitmap.prototype =
{
    from_dv: function(dv, at, mb)
    {
        this.format = dv.getUint8(at, true); at++;
        this.flags  = dv.getUint8(at, true); at++;
        this.x = dv.getUint32(at, true); at += 4;
        this.y = dv.getUint32(at, true); at += 4;
        this.stride = dv.getUint32(at, true); at += 4;
        if (this.flags & Constants.SPICE_BITMAP_FLAGS_PAL_FROM_CACHE)
        {
            this.palette_id = dv.getBigUint64(at, true); at += 8;
        }
        else
        {
            var offset = dv.getUint32(at, true); at += 4;
            if (offset == 0)
                this.palette = null;
            else
            {
                this.palette = new SpicePalette;
                this.palette.from_dv(dv, offset, mb);
            }
        }
        // FIXME - should probably constrain this to the offset
        //          of palette, if non zero
        this.data   = mb.slice(at);
        at += this.data.byteLength;
        return at;
    },
}

function SpiceImage()
{
}

SpiceImage.prototype =
{
    from_dv: function(dv, at, mb)
    {
        this.descriptor = new SpiceImageDescriptor;
        at = this.descriptor.from_dv(dv, at, mb);

        if (this.descriptor.type == Constants.SPICE_IMAGE_TYPE_LZ_RGB)
        {
            this.lz_rgb = new Object();
            this.lz_rgb.length = dv.getUint32(at, true); at += 4;
            var initial_at = at;
            this.lz_rgb.magic = "";
            for (var i = 3; i >= 0; i--)
                this.lz_rgb.magic += String.fromCharCode(dv.getUint8(at + i));
            at += 4;

            // NOTE:  The endian change is *correct*
            this.lz_rgb.version = dv.getUint32(at); at += 4;
            this.lz_rgb.type = dv.getUint32(at); at += 4;
            this.lz_rgb.width = dv.getUint32(at); at += 4;
            this.lz_rgb.height = dv.getUint32(at); at += 4;
            this.lz_rgb.stride = dv.getUint32(at); at += 4;
            this.lz_rgb.top_down = dv.getUint32(at); at += 4;

            var header_size = at - initial_at;

            this.lz_rgb.data   = mb.slice(at, this.lz_rgb.length + at - header_size);
            at += this.lz_rgb.data.byteLength;

        }

        if (this.descriptor.type == Constants.SPICE_IMAGE_TYPE_LZ4)
        {
            this.lz4 = new Object();
            this.lz4.data_size = dv.getUint32(at, true); at += 4;
            this.lz4.data = mb.slice(at, at + this.lz4.data_size);
            at += this.lz4.data.byteLength;
        }

        if (this.descriptor.type == Constants.SPICE_IMAGE_TYPE_BITMAP)
        {
            this.bitmap = new SpiceBitmap;
            at = this.bitmap.from_dv(dv, at, mb);
        }

        if (this.descriptor.type == Constants.SPICE_IMAGE_TYPE_SURFACE)
        {
            this.surface_id = dv.getUint32(at, true); at += 4;
        }

        if (this.descriptor.type == Constants.SPICE_IMAGE_TYPE_JPEG)
        {
            this.jpeg = new Object;
            this.jpeg.data_size = dv.getUint32(at, true); at += 4;
            this.jpeg.data = mb.slice(at);
            at += this.jpeg.data.byteLength;
        }

        if (this.descriptor.type == Constants.SPICE_IMAGE_TYPE_JPEG_ALPHA)
        {
            this.jpeg_alpha = new Object;
            this.jpeg_alpha.flags = dv.getUint8(at, true); at += 1;
            this.jpeg_alpha.jpeg_size = dv.getUint32(at, true); at += 4;
            this.jpeg_alpha.data_size = dv.getUint32(at, true); at += 4;
            this.jpeg_alpha.data = mb.slice(at, this.jpeg_alpha.jpeg_size + at);
            at += this.jpeg_alpha.data.byteLength;
            // Alpha channel is an LZ image
            this.jpeg_alpha.alpha = new Object();
            this.jpeg_alpha.alpha.length = this.jpeg_alpha.data_size - this.jpeg_alpha.jpeg_size;
            var initial_at = at;
            this.jpeg_alpha.alpha.magic = "";
            for (var i = 3; i >= 0; i--)
                this.jpeg_alpha.alpha.magic += String.fromCharCode(dv.getUint8(at + i));
            at += 4;

            // NOTE:  The endian change is *correct*
            this.jpeg_alpha.alpha.version = dv.getUint32(at); at += 4;
            this.jpeg_alpha.alpha.type = dv.getUint32(at); at += 4;
            this.jpeg_alpha.alpha.width = dv.getUint32(at); at += 4;
            this.jpeg_alpha.alpha.height = dv.getUint32(at); at += 4;
            this.jpeg_alpha.alpha.stride = dv.getUint32(at); at += 4;
            this.jpeg_alpha.alpha.top_down = dv.getUint32(at); at += 4;

            var header_size = at - initial_at;

            this.jpeg_alpha.alpha.data   = mb.slice(at, this.jpeg_alpha.alpha.length + at - header_size);
            at += this.jpeg_alpha.alpha.data.byteLength;
        }

        if (this.descriptor.type == Constants.SPICE_IMAGE_TYPE_QUIC)
        {
            this.quic = new SpiceQuic;
            at = this.quic.from_dv(dv, at, mb);
        }
        return at;
    },
}


function SpiceQMask()
{
}

SpiceQMask.prototype =
{
    from_dv: function(dv, at, mb)
    {
        this.flags  = dv.getUint8(at, true); at++;
        this.pos = new SpicePoint;
        at = this.pos.from_dv(dv, at, mb);
        var offset = dv.getUint32(at, true); at += 4;
        if (offset == 0)
        {
            this.bitmap = null;
            return at;
        }

        this.bitmap = new SpiceImage;
        return this.bitmap.from_dv(dv, offset, mb);
    },
}


function SpicePattern()
{
}

SpicePattern.prototype =
{
    from_dv: function(dv, at, mb)
    {
        var offset = dv.getUint32(at, true); at += 4;
        if (offset == 0)
        {
            this.pat = null;
        }
        else
        {
            this.pat = new SpiceImage;
            this.pat.from_dv(dv, offset, mb);
        }

        this.pos = new SpicePoint;
        return this.pos.from_dv(dv, at, mb);
    }
}

function SpiceBrush()
{
}

SpiceBrush.prototype =
{
    from_dv: function(dv, at, mb)
    {
        this.type = dv.getUint8(at, true); at ++;
        if (this.type == Constants.SPICE_BRUSH_TYPE_SOLID)
        {
            this.color = dv.getUint32(at, true); at += 4;
        }
        else if (this.type == Constants.SPICE_BRUSH_TYPE_PATTERN)
        {
            this.pattern = new SpicePattern;
            at = this.pattern.from_dv(dv, at, mb);
        }
        return at;
    },
}

function SpiceFill()
{
}

SpiceFill.prototype =
{
    from_dv: function(dv, at, mb)
    {
        this.brush = new SpiceBrush;
        at = this.brush.from_dv(dv, at, mb);
        this.rop_descriptor = dv.getUint16(at, true); at += 2;
        this.mask = new SpiceQMask;
        return this.mask.from_dv(dv, at, mb);
    },
}


function SpiceCopy()
{
}

SpiceCopy.prototype =
{
    from_dv: function(dv, at, mb)
    {
        var offset = dv.getUint32(at, true); at += 4;
        if (offset == 0)
        {
            this.src_bitmap = null;
        }
        else
        {
            this.src_bitmap = new SpiceImage;
            this.src_bitmap.from_dv(dv, offset, mb);
        }
        this.src_area = new SpiceRect;
        at = this.src_area.from_dv(dv, at, mb);
        this.rop_descriptor = dv.getUint16(at, true); at += 2;
        this.scale_mode = dv.getUint8(at, true); at ++;
        this.mask = new SpiceQMask;
        return this.mask.from_dv(dv, at, mb);
    },
}

function SpiceAlphaBlend()
{
}

SpiceAlphaBlend.prototype =
{
    from_dv: function(dv, at, mb)
    {
        this.alpha_flags = dv.getUint8(at, true); at++;
        this.alpha = dv.getUint8(at, true); at++;
        var offset = dv.getUint32(at, true); at += 4;
        if (offset == 0)
            this.src_bitmap = null;
        else
        {
            this.src_bitmap = new SpiceImage;
            this.src_bitmap.from_dv(dv, offset, mb);
        }
        this.src_area = new SpiceRect;
        return this.src_area.from_dv(dv, at, mb);
    },
}

/* Signed, unlike SpicePoint: a glyph origin sits above its baseline. */
function SpiceSignedPoint()
{
}

SpiceSignedPoint.prototype =
{
    from_dv: function(dv, at, mb)
    {
        this.x = dv.getInt32(at, true); at += 4;
        this.y = dv.getInt32(at, true); at += 4;
        return at;
    },
}

/* A run of raster glyphs, laid out one after another on the wire.  Each
   row of an A1 glyph is packed most significant bit first and padded to
   a byte; A4 packs two pixels a byte, high nibble first; A8 is a byte a
   pixel.  Rows come bottom-up unless RASTER_TOP_DOWN is set. */
function SpiceString()
{
}

SpiceString.prototype =
{
    from_dv: function(dv, at, mb)
    {
        this.length = dv.getUint16(at, true); at += 2;
        this.flags = dv.getUint8(at, true); at++;
        var bits = (this.flags & Constants.SPICE_STRING_FLAGS_RASTER_A8) ? 8 :
                   (this.flags & Constants.SPICE_STRING_FLAGS_RASTER_A4) ? 4 : 1;
        this.bits = bits;
        this.glyphs = [];
        for (var i = 0; i < this.length; i++)
        {
            var g = {};
            g.render_pos = new SpiceSignedPoint;
            at = g.render_pos.from_dv(dv, at, mb);
            g.glyph_origin = new SpiceSignedPoint;
            at = g.glyph_origin.from_dv(dv, at, mb);
            g.width = dv.getUint16(at, true); at += 2;
            g.height = dv.getUint16(at, true); at += 2;
            g.stride = (g.width * bits + 7) >> 3;
            g.data = new Uint8Array(mb, at, g.stride * g.height);
            at += g.stride * g.height;
            this.glyphs.push(g);
        }
        return at;
    },
}

function SpiceText()
{
}

SpiceText.prototype =
{
    from_dv: function(dv, at, mb)
    {
        var offset = dv.getUint32(at, true); at += 4;
        if (offset == 0)
            this.str = null;
        else
        {
            this.str = new SpiceString;
            this.str.from_dv(dv, offset, mb);
        }
        this.back_area = new SpiceRect;
        at = this.back_area.from_dv(dv, at, mb);
        this.fore_brush = new SpiceBrush;
        at = this.fore_brush.from_dv(dv, at, mb);
        this.back_brush = new SpiceBrush;
        at = this.back_brush.from_dv(dv, at, mb);
        this.fore_mode = dv.getUint16(at, true); at += 2;
        this.back_mode = dv.getUint16(at, true); at += 2;
        return at;
    },
}

/* Segments follow one another on the wire; points are 28.4 fixed. */
function SpicePath()
{
}

SpicePath.prototype =
{
    from_dv: function(dv, at, mb)
    {
        var count = dv.getUint32(at, true); at += 4;
        this.segments = [];
        for (var i = 0; i < count; i++)
        {
            var seg = { flags: dv.getUint8(at, true), points: [] };
            at++;
            var n = dv.getUint32(at, true); at += 4;
            for (var p = 0; p < n; p++)
            {
                seg.points.push({ x: dv.getInt32(at, true) / 16, y: dv.getInt32(at + 4, true) / 16 });
                at += 8;
            }
            this.segments.push(seg);
        }
        return at;
    },
}

function SpiceLineAttr()
{
}

SpiceLineAttr.prototype =
{
    from_dv: function(dv, at, mb)
    {
        this.flags = dv.getUint8(at, true); at++;
        this.style = [];
        if (this.flags & Constants.SPICE_LINE_FLAGS_STYLED)
        {
            var n = dv.getUint8(at, true); at++;
            var offset = dv.getUint32(at, true); at += 4;
            for (var i = 0; i < n; i++)
                this.style.push(dv.getInt32(offset + i * 4, true) / 16);
        }
        return at;
    },
}

function SpiceStroke()
{
}

SpiceStroke.prototype =
{
    from_dv: function(dv, at, mb)
    {
        var offset = dv.getUint32(at, true); at += 4;
        if (offset == 0)
            this.path = null;
        else
        {
            this.path = new SpicePath;
            this.path.from_dv(dv, offset, mb);
        }
        this.attr = new SpiceLineAttr;
        at = this.attr.from_dv(dv, at, mb);
        this.brush = new SpiceBrush;
        at = this.brush.from_dv(dv, at, mb);
        this.fore_mode = dv.getUint16(at, true); at += 2;
        this.back_mode = dv.getUint16(at, true); at += 2;
        return at;
    },
}

function SpicePoint16()
{
}

SpicePoint16.prototype =
{
    from_dv: function(dv, at, mb)
    {
        this.x = dv.getUint16(at, true); at += 2;
        this.y = dv.getUint16(at, true); at += 2;
        return at;
    },
}

function SpicePoint()
{
}

SpicePoint.prototype =
{
    from_dv: function(dv, at, mb)
    {
        this.x = dv.getUint32(at, true); at += 4;
        this.y = dv.getUint32(at, true); at += 4;
        return at;
    },
}

function SpiceCursorHeader()
{
}

SpiceCursorHeader.prototype =
{
    from_dv: function(dv, at, mb)
    {
        this.unique = dv.getBigUint64(at, true); at += 8;
        this.type = dv.getUint8(at, true); at ++;
        this.width = dv.getUint16(at, true); at += 2;
        this.height = dv.getUint16(at, true); at += 2;
        this.hot_spot_x = dv.getUint16(at, true); at += 2;
        this.hot_spot_y = dv.getUint16(at, true); at += 2;
        return at;
    },
}

function SpiceCursor()
{
}

SpiceCursor.prototype =
{
    from_dv: function(dv, at, mb)
    {
        this.flags = dv.getUint16(at, true); at += 2;
        if (this.flags & Constants.SPICE_CURSOR_FLAGS_NONE)
            this.header = null;
        else
        {
            this.header = new SpiceCursorHeader;
            at = this.header.from_dv(dv, at, mb);
            this.data   = mb.slice(at);
            at += this.data.byteLength;
        }
        return at;
    },
}

function SpiceSurface()
{
}

SpiceSurface.prototype =
{
    from_dv: function(dv, at, mb)
    {
        this.surface_id = dv.getUint32(at, true); at += 4;
        this.width = dv.getUint32(at, true); at += 4;
        this.height = dv.getUint32(at, true); at += 4;
        this.format = dv.getUint32(at, true); at += 4;
        this.flags = dv.getUint32(at, true); at += 4;
        return at;
    },
}

/* FIXME - SpiceImage  types lz_plt, jpeg, zlib_glz, and jpeg_alpha are
           completely unimplemented */

export {
  SpiceChannelId,
  SpiceRect,
  SpiceClipRects,
  SpiceClip,
  SpiceImageDescriptor,
  SpicePalette,
  SpiceBitmap,
  SpiceImage,
  SpiceQMask,
  SpicePattern,
  SpiceBrush,
  SpiceFill,
  SpiceCopy,
  SpiceAlphaBlend,
  SpiceString,
  SpiceText,
  SpicePath,
  SpiceLineAttr,
  SpiceStroke,
  SpicePoint16,
  SpicePoint,
  SpiceCursorHeader,
  SpiceCursor,
  SpiceSurface,
};
