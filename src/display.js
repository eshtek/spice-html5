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

import * as Webm from './webm.js';
import * as Messages from './spicemsg.js';
import * as Quic from './quic.js';
import * as Utils from './utils.js';
import * as Inputs from './inputs.js';
import { Constants } from './enums.js';
import { SpiceConn } from './spiceconn.js';
import { SpiceRect } from './spicetype.js';
import { convert_spice_lz_to_web } from './lz.js';
import { convert_spice_bitmap_to_web, convert_spice_mask } from './bitmap.js';
import { convert_spice_lz4_to_web } from './lz4.js';
import { VideoCodecs, video_decoder_codec, video_keyframe } from './videocodecs.js';

/*----------------------------------------------------------------------------
**  FIXME: putImageData  does not support Alpha blending
**           or compositing.  So if we have data in an ImageData
**           format, we have to draw it onto a context,
**           and then use drawImage to put it onto the target,
**           as drawImage does alpha.
**--------------------------------------------------------------------------*/
/* One shared scratch canvas; allocating a fresh one per draw dominated
   profiles under drawing-heavy guests. It only ever grows. */
var scratch_canvas = null;
var scratch_context = null;

/* Draws the src rectangle of d at x,y scaled to dw x dh, blending. */
function putImageDataWithAlpha(context, d, x, y, src, dw, dh)
{
    if (scratch_canvas === null)
    {
        scratch_canvas = document.createElement("canvas");
        scratch_context = scratch_canvas.getContext("2d");
    }
    if (scratch_canvas.width < d.width)
        scratch_canvas.width = d.width;
    if (scratch_canvas.height < d.height)
        scratch_canvas.height = d.height;
    scratch_context.putImageData(d, 0, 0);
    context.drawImage(scratch_canvas, src.left, src.top, src.right - src.left, src.bottom - src.top, x, y, dw, dh);
}

/* The part of an image a draw uses: its src_area, or all of it. */
function source_rect(o, width, height)
{
    if (o.src_area)
        return o.src_area;
    return { left: 0, top: 0, right: width, bottom: height };
}

/* The decoded pixels of an image element, read back through the scratch
   canvas rather than the surface, so a clipped draw can still cache the
   whole image. */
function image_to_image_data(img, width, height)
{
    if (scratch_canvas === null)
    {
        scratch_canvas = document.createElement("canvas");
        scratch_context = scratch_canvas.getContext("2d");
    }
    if (scratch_canvas.width < width)
        scratch_canvas.width = width;
    if (scratch_canvas.height < height)
        scratch_canvas.height = height;
    scratch_context.clearRect(0, 0, width, height);
    scratch_context.drawImage(img, 0, 0);
    return scratch_context.getImageData(0, 0, width, height);
}

/* A VP8 stream paints into a video element over the canvas, out of reach
   of the canvas clip; CSS clip-path carries the same rectangles, relative
   to the element's own origin. A bottom-up stream is shown through a
   scaleY(-1) transform, which flips the clip-path along with the pixels,
   so its rectangles are mirrored here to land where the server put them. */
function apply_video_clip(stream)
{
    if (! stream.video)
        return;
    if (! is_clipped(stream.clip))
    {
        stream.video.style.clipPath = "";
        return;
    }
    var rects = stream.clip.rects.rects || [];
    if (rects.length == 0)
    {
        stream.video.style.clipPath = "inset(100%)";
        return;
    }
    var flipped = ! (stream.flags & Constants.SPICE_STREAM_FLAGS_TOP_DOWN);
    var path = "";
    for (var i = 0; i < rects.length; i++)
    {
        var w = rects[i].right - rects[i].left;
        var h = rects[i].bottom - rects[i].top;
        var x = rects[i].left - stream.dest.left;
        var y = rects[i].top - stream.dest.top;
        if (flipped)
            y = stream.stream_height - y - h;
        path += "M" + x + " " + y + "h" + w + "v" + h + "h" + (-w) + "z";
    }
    stream.video.style.clipPath = 'path("' + path + '")';
}

function is_clipped(clip)
{
    return clip !== undefined && clip.type == Constants.SPICE_CLIP_TYPE_RECTS;
}

/* Runs draw with the context clipped to the rectangles of a
   SPICE_CLIP_TYPE_RECTS clip, the way spice-gtk clips every operation. A
   clip with no rectangles paints nothing. Only path-based drawing honours
   the clip region: putImageData does not, so clipped bitmap draws must go
   through drawImage. */
function with_clip(context, clip, draw)
{
    if (! is_clipped(clip))
    {
        draw();
        return;
    }
    var rects = clip.rects.rects || [];
    if (rects.length == 0)
        return;
    context.save();
    context.beginPath();
    for (var i = 0; i < rects.length; i++)
        context.rect(rects[i].left, rects[i].top,
                     rects[i].right - rects[i].left,
                     rects[i].bottom - rects[i].top);
    context.clip();
    draw();
    context.restore();
}

/*----------------------------------------------------------------------------
**  FIXME: Spice will send an image with '0' alpha when it is intended to
**           go on a surface w/no alpha.  So in that case, we have to strip
**           out the alpha.  The test case for this was flux box; in a Xspice
**           server, right click on the desktop to get the menu; the top bar
**           doesn't paint/highlight correctly w/out this change.
**--------------------------------------------------------------------------*/
function stripAlpha(d)
{
    var i;
    var words = new Uint32Array(d.data.buffer);
    var n = words.length;
    for (i = 0; i < n; i++)
        words[i] |= 0xff000000;
}

/* putImageData ignores the clip region but takes a dirty rectangle, so an
   opaque clipped draw is one put per clip rectangle, each limited to the
   rectangle's intersection with the image: no blend, no scratch canvas.
   A clip with no rectangles paints nothing, as with_clip does. */
function putImageDataClipped(context, d, x, y, clip, src)
{
    var rects = clip.rects.rects || [];
    var width = src.right - src.left;
    var height = src.bottom - src.top;
    for (var i = 0; i < rects.length; i++)
    {
        var left = Math.max(rects[i].left, x);
        var top = Math.max(rects[i].top, y);
        var right = Math.min(rects[i].right, x + width);
        var bottom = Math.min(rects[i].bottom, y + height);
        if (right > left && bottom > top)
            context.putImageData(d, x - src.left, y - src.top,
                                 src.left + left - x, src.top + top - y, right - left, bottom - top);
    }
}

/* "rgb(r, g, b)" for a solid brush, undefined for the pattern kind. */
function brush_color(brush)
{
    if (! brush || brush.type != Constants.SPICE_BRUSH_TYPE_SOLID)
        return undefined;
    var color = brush.color & 0xffffff;
    return "rgb(" + (color >> 16) + ", " + ((color >> 8) & 0xff) + ", " + (color & 0xff) + ")";
}

/* The parts of a box a draw may touch: the box itself, or its
   intersection with each clip rectangle. */
function clipped_rects(box, clip)
{
    if (! is_clipped(clip))
        return [ box ];
    var rects = clip.rects.rects || [];
    var out = [];
    for (var i = 0; i < rects.length; i++)
    {
        var r = { left: Math.max(rects[i].left, box.left), top: Math.max(rects[i].top, box.top),
                  right: Math.min(rects[i].right, box.right), bottom: Math.min(rects[i].bottom, box.bottom) };
        if (r.right > r.left && r.bottom > r.top)
            out.push(r);
    }
    return out;
}

/* The glyphs of a string as one RGBA image in the fore colour, alpha
   from coverage, positioned at its top-left; undefined for no glyphs. */
function render_string_mask(str, color)
{
    var g, i, x, y;
    if (! str || str.glyphs.length == 0)
        return undefined;
    var left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (i = 0; i < str.glyphs.length; i++)
    {
        g = str.glyphs[i];
        var gl = g.render_pos.x + g.glyph_origin.x;
        var gt = g.render_pos.y + g.glyph_origin.y;
        left = Math.min(left, gl);
        top = Math.min(top, gt);
        right = Math.max(right, gl + g.width);
        bottom = Math.max(bottom, gt + g.height);
    }
    var w = right - left, h = bottom - top;
    if (w <= 0 || h <= 0)
        return undefined;
    var image_data = new ImageData(w, h);
    var p = image_data.data;
    var cr = (color >> 16) & 0xff, cg = (color >> 8) & 0xff, cb = color & 0xff;
    var top_down = str.flags & Constants.SPICE_STRING_FLAGS_RASTER_TOP_DOWN;
    for (i = 0; i < str.glyphs.length; i++)
    {
        g = str.glyphs[i];
        var ox = g.render_pos.x + g.glyph_origin.x - left;
        var oy = g.render_pos.y + g.glyph_origin.y - top;
        for (y = 0; y < g.height; y++)
        {
            var row = (top_down ? y : g.height - 1 - y) * g.stride;
            for (x = 0; x < g.width; x++)
            {
                var a;
                if (str.bits == 1)
                    a = (g.data[row + (x >> 3)] & (0x80 >> (x & 7))) ? 255 : 0;
                else if (str.bits == 4)
                {
                    var b = g.data[row + (x >> 1)];
                    a = ((x & 1) ? (b & 0x0f) : (b >> 4)) * 17;
                }
                else
                    a = g.data[row + x];
                if (! a)
                    continue;
                var o = ((oy + y) * w + ox + x) * 4;
                p[o] = cr;
                p[o + 1] = cg;
                p[o + 2] = cb;
                if (a > p[o + 3])
                    p[o + 3] = a;
            }
        }
    }
    return { image_data: image_data, left: left, top: top, width: w, height: h };
}

/*----------------------------------------------------------------------------
**  Raster ops.  A rop descriptor names an operation and which operands
**  to invert; canvas_base resolves it to one of sixteen binary ops given
**  which two inputs (source, brush, destination) it combines.  The ops
**  run on bytes, one channel at a time, so they work on whatever the
**  canvas hands back.
**--------------------------------------------------------------------------*/
var ROP = { COPY: 0, COPY_INVERTED: 1, AND: 2, AND_REVERSE: 3, AND_INVERTED: 4, OR: 5, OR_REVERSE: 6,
            OR_INVERTED: 7, XOR: 8, EQUIV: 9, NOR: 10, NAND: 11, INVERT: 12, CLEAR: 13, SET: 14, NOOP: 15 };
var ROP_INPUT_SRC = 0, ROP_INPUT_BRUSH = 1, ROP_INPUT_DEST = 2;

function ropd_to_rop(desc, src_input, dest_input)
{
    var invert_masks = [ Constants.SPICE_ROPD_INVERS_SRC, Constants.SPICE_ROPD_INVERS_BRUSH, Constants.SPICE_ROPD_INVERS_DEST ];
    var inv_src = !!(desc & invert_masks[src_input]);
    var inv_dest = !!(desc & invert_masks[dest_input]);
    var inv_res = !!(desc & Constants.SPICE_ROPD_INVERS_RES);
    if (desc & Constants.SPICE_ROPD_OP_PUT)
        return (inv_src != inv_res) ? ROP.COPY_INVERTED : ROP.COPY;
    if (desc & Constants.SPICE_ROPD_OP_OR)
    {
        if (inv_res)
            return inv_src ? (inv_dest ? ROP.AND : ROP.AND_REVERSE) : (inv_dest ? ROP.AND_INVERTED : ROP.NOR);
        return inv_src ? (inv_dest ? ROP.NAND : ROP.OR_INVERTED) : (inv_dest ? ROP.OR_REVERSE : ROP.OR);
    }
    if (desc & Constants.SPICE_ROPD_OP_AND)
    {
        if (inv_res)
            return inv_src ? (inv_dest ? ROP.OR : ROP.OR_REVERSE) : (inv_dest ? ROP.OR_INVERTED : ROP.NAND);
        return inv_src ? (inv_dest ? ROP.NOR : ROP.AND_INVERTED) : (inv_dest ? ROP.AND_REVERSE : ROP.AND);
    }
    if (desc & Constants.SPICE_ROPD_OP_XOR)
        return (inv_src != inv_dest) != inv_res ? ROP.EQUIV : ROP.XOR;
    if (desc & Constants.SPICE_ROPD_OP_BLACKNESS)
        return inv_res ? ROP.SET : ROP.CLEAR;
    if (desc & Constants.SPICE_ROPD_OP_WHITENESS)
        return inv_res ? ROP.CLEAR : ROP.SET;
    if (desc & Constants.SPICE_ROPD_OP_INVERS)
        return inv_res ? ROP.NOOP : ROP.INVERT;
    return ROP.NOOP;
}

function rop_apply(rop, s, d)
{
    switch (rop)
    {
        case ROP.COPY: return s;
        case ROP.COPY_INVERTED: return ~s & 0xff;
        case ROP.AND: return s & d;
        case ROP.AND_REVERSE: return s & ~d & 0xff;
        case ROP.AND_INVERTED: return ~s & d & 0xff;
        case ROP.OR: return s | d;
        case ROP.OR_REVERSE: return (s | ~d) & 0xff;
        case ROP.OR_INVERTED: return (~s | d) & 0xff;
        case ROP.XOR: return s ^ d;
        case ROP.EQUIV: return ~(s ^ d) & 0xff;
        case ROP.NOR: return ~(s | d) & 0xff;
        case ROP.NAND: return ~(s & d) & 0xff;
        case ROP.INVERT: return ~d & 0xff;
        case ROP.CLEAR: return 0;
        case ROP.SET: return 0xff;
    }
    return d;
}

/* A Windows ternary rop on one byte: bit (p, s, d) of the code says
   what a bit of pattern, source and destination becomes, so the code's
   eight bits pick which of the eight minterms are kept. */
function rop3_byte(code, p, s, d)
{
    var np = ~p & 0xff, ns = ~s & 0xff, nd = ~d & 0xff;
    var r = 0;
    if (code & 1)   r |= np & ns & nd;
    if (code & 2)   r |= np & ns & d;
    if (code & 4)   r |= np & s & nd;
    if (code & 8)   r |= np & s & d;
    if (code & 16)  r |= p & ns & nd;
    if (code & 32)  r |= p & ns & d;
    if (code & 64)  r |= p & s & nd;
    if (code & 128) r |= p & s & d;
    return r;
}

/*----------------------------------------------------------------------------
**  Combine tables.  A pixel op is three byte lookup tables, one per
**  channel, indexed by the destination byte ("d"), the source byte
**  ("s") or both ("sd": source << 8 | destination), so the pixel loop
**  does a read and a write per channel with no call and no switch.
**  Building a 64K table costs about as much as a 150x150 op, so the
**  ones that recur are kept.
**--------------------------------------------------------------------------*/
var ROP_TABLES = [];
var ROP3_TABLES = {};
var ROP3_TABLES_MAX = 32;

function channel_tables(by, fn)
{
    var n = by == "sd" ? 65536 : 256;
    var t = [ new Uint8Array(n), new Uint8Array(n), new Uint8Array(n) ];
    for (var c = 0; c < 3; c++)
        for (var i = 0; i < n; i++)
            t[c][i] = by == "sd" ? fn(c, i >> 8, i & 0xff) : fn(c, i, i);
    return { by: by, r: t[0], g: t[1], b: t[2] };
}

/* Source combined with destination by a binary rop. */
function rop_tables(rop)
{
    if (! ROP_TABLES[rop])
    {
        var t = new Uint8Array(65536);
        for (var i = 0; i < 65536; i++)
            t[i] = rop_apply(rop, i >> 8, i & 0xff);
        ROP_TABLES[rop] = { by: "sd", r: t, g: t, b: t };
    }
    return ROP_TABLES[rop];
}

/* A solid brush combined with the source by a binary rop (Opaque). */
function brush_tables(rop, color)
{
    var ch = [ (color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff ];
    return channel_tables("s", function(c, s) { return rop_apply(rop, ch[c], s); });
}

/* A solid brush put over, or xored into, the destination. */
function fill_tables(color, xor)
{
    var ch = [ (color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff ];
    return channel_tables("d", function(c, d) { return xor ? d ^ ch[c] : ch[c]; });
}

/* The destination alone: a constant, or inverted. */
function dest_tables(value, invert)
{
    return channel_tables("d", function(c, d) { return invert ? 255 - d : value; });
}

/* A ternary rop with a solid brush as the pattern. */
function rop3_tables(code, color)
{
    var key = code + ":" + (color & 0xffffff);
    if (! ROP3_TABLES[key])
    {
        if (Object.keys(ROP3_TABLES).length >= ROP3_TABLES_MAX)
            ROP3_TABLES = {};
        var ch = [ (color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff ];
        ROP3_TABLES[key] = channel_tables("sd", function(c, s, d) { return rop3_byte(code, ch[c], s, d); });
    }
    return ROP3_TABLES[key];
}

/* The same tables, applied to the alpha byte as well (the r table), for
   a copy onto a surface whose alpha is part of the image. */
function with_alpha(tables)
{
    return { by: tables.by, r: tables.r, g: tables.g, b: tables.b, alpha: true };
}

/* The r table applied to the alpha byte alone, for an A8 surface. */
function alpha_only(tables)
{
    return { by: tables.by, r: tables.r, g: tables.g, b: tables.b, alpha: true, alpha_only: true };
}

/* Applies `tables` to the pixels of `rects` (the parts of `box` a draw
   may touch), reading each back from the context and writing it again.
   Source bytes come from source.image_data at the position matching
   the destination pixel through source.src (its src_area) when the
   tables want them; mask.bits, offset by mask.pos, excludes pixels.
   Colour goes through r, g and b; the alpha byte through r as well
   when tables.alpha is set, and only the alpha byte with alpha_only. */
function combine_rects(context, box, rects, source, mask, tables)
{
    var by_sd = tables.by == "sd", by_s = tables.by == "s";
    var tr = tables.r, tg = tables.g, tb = tables.b;
    var alpha = !! tables.alpha, colour = ! tables.alpha_only;
    var s_data = source ? source.image_data.data : null;
    var s_w = source ? source.image_data.width : 0;
    var s_left = source ? source.src.left : 0;
    var s_top = source ? source.src.top : 0;
    for (var i = 0; i < rects.length; i++)
    {
        var r = rects[i];
        var w = r.right - r.left, h = r.bottom - r.top;
        var d = context.getImageData(r.left, r.top, w, h);
        var out = d.data;
        var o = 0;
        for (var y = 0; y < h; y++)
        {
            var py = r.top + y;
            var my = mask ? py - box.top + mask.pos.y : 0;
            if (mask && (my < 0 || my >= mask.height))
            {
                o += w * 4;
                continue;
            }
            var mrow = my * (mask ? mask.width : 0);
            var srow = (py - box.top + s_top) * s_w;
            for (var x = 0; x < w; x++, o += 4)
            {
                var px = r.left + x;
                if (mask)
                {
                    var mx = px - box.left + mask.pos.x;
                    if (mx < 0 || mx >= mask.width || ! mask.bits[mrow + mx])
                        continue;
                }
                if (by_sd)
                {
                    var so = (srow + px - box.left + s_left) * 4;
                    if (colour)
                    {
                        out[o] = tr[(s_data[so] << 8) | out[o]];
                        out[o + 1] = tg[(s_data[so + 1] << 8) | out[o + 1]];
                        out[o + 2] = tb[(s_data[so + 2] << 8) | out[o + 2]];
                    }
                    if (alpha)
                        out[o + 3] = tr[(s_data[so + 3] << 8) | out[o + 3]];
                }
                else if (by_s)
                {
                    var so = (srow + px - box.left + s_left) * 4;
                    if (colour)
                    {
                        out[o] = tr[s_data[so]];
                        out[o + 1] = tg[s_data[so + 1]];
                        out[o + 2] = tb[s_data[so + 2]];
                    }
                    if (alpha)
                        out[o + 3] = tr[s_data[so + 3]];
                }
                else
                {
                    if (colour)
                    {
                        out[o] = tr[out[o]];
                        out[o + 1] = tg[out[o + 1]];
                        out[o + 2] = tb[out[o + 2]];
                    }
                    if (alpha)
                        out[o + 3] = tr[out[o + 3]];
                }
            }
        }
        context.putImageData(d, r.left, r.top);
    }
}

/* Render's PictOp codes as canvas blend modes; "clear" and "dst" are
   special-cased by the caller, saturate is approximated by add. */
var COMPOSITE_OPS = {};
COMPOSITE_OPS[Constants.SPICE_COMPOSITE_OP_CLEAR] = "clear";
COMPOSITE_OPS[Constants.SPICE_COMPOSITE_OP_SRC] = "copy";
COMPOSITE_OPS[Constants.SPICE_COMPOSITE_OP_DST] = "dst";
COMPOSITE_OPS[Constants.SPICE_COMPOSITE_OP_OVER] = "source-over";
COMPOSITE_OPS[Constants.SPICE_COMPOSITE_OP_OVER_REVERSE] = "destination-over";
COMPOSITE_OPS[Constants.SPICE_COMPOSITE_OP_IN] = "source-in";
COMPOSITE_OPS[Constants.SPICE_COMPOSITE_OP_IN_REVERSE] = "destination-in";
COMPOSITE_OPS[Constants.SPICE_COMPOSITE_OP_OUT] = "source-out";
COMPOSITE_OPS[Constants.SPICE_COMPOSITE_OP_OUT_REVERSE] = "destination-out";
COMPOSITE_OPS[Constants.SPICE_COMPOSITE_OP_ATOP] = "source-atop";
COMPOSITE_OPS[Constants.SPICE_COMPOSITE_OP_ATOP_REVERSE] = "destination-atop";
COMPOSITE_OPS[Constants.SPICE_COMPOSITE_OP_XOR] = "xor";
COMPOSITE_OPS[Constants.SPICE_COMPOSITE_OP_ADD] = "lighter";
COMPOSITE_OPS[Constants.SPICE_COMPOSITE_OP_SATURATE] = "lighter";

/* Canvases a Composite draws its operands through, kept between draws:
   a desktop with Render issues one Composite per glyph run, and three
   fresh canvases per op is most of its cost. The two layers only grow
   and are cleared where used; the operand is sized to its image, since
   createPattern tiles the whole canvas. */
var composite_canvases = [];

function composite_canvas(index, w, h, exact)
{
    var c = composite_canvases[index];
    if (! c)
        c = composite_canvases[index] = document.createElement("canvas");
    if (exact ? (c.width != w || c.height != h) : (c.width < w || c.height < h))
    {
        c.width = exact ? w : Math.max(c.width, w);
        c.height = exact ? h : Math.max(c.height, h);
    }
    return c;
}

/* A composite operand rendered onto a layer canvas, of which the top
   left w x h is the destination box.  Render samples the operand at
   transform * (dest + origin); the canvas maps operand to destination,
   so it gets the inverse.  Repeat 1 tiles; filter 0 is nearest. */
function composite_layer(index, image_data, origin, transform, repeat, filter, w, h)
{
    var layer = composite_canvas(index, w, h, false);
    var ctx = layer.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, w, h);
    var operand = composite_canvas(2, image_data.width, image_data.height, true);
    operand.getContext("2d").putImageData(image_data, 0, 0);
    ctx.imageSmoothingEnabled = filter != 0;
    var t = transform || [1, 0, 0, 0, 1, 0];
    /* t maps (x + ox, y + oy) to operand space: [t0 t1 t2; t3 t4 t5]. */
    var det = t[0] * t[4] - t[1] * t[3];
    if (! det)
        return layer;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.clip();
    var ia = t[4] / det, ib = -t[3] / det, ic = -t[1] / det, id = t[0] / det;
    var ie = -(ia * t[2] + ic * t[5]) - origin.x;
    var iff = -(ib * t[2] + id * t[5]) - origin.y;
    ctx.setTransform(ia, ib, ic, id, ie, iff);
    if (repeat == 1)
    {
        ctx.fillStyle = ctx.createPattern(operand, "repeat");
        var reach = Math.max(w, h, image_data.width, image_data.height) * 4;
        ctx.fillRect(-reach, -reach, reach * 2, reach * 2);
    }
    else
        ctx.drawImage(operand, 0, 0);
    ctx.restore();
    return layer;
}

/* The source of a draw as an image the size of its box: the src_area
   scaled when the sizes differ, so combine_rects can read it 1:1. */
function source_for_box(image_data, src, box)
{
    var w = box.right - box.left, h = box.bottom - box.top;
    var sw = src.right - src.left, sh = src.bottom - src.top;
    if (sw == w && sh == h)
        return { image_data: image_data, src: src };
    if (scratch_canvas === null)
    {
        scratch_canvas = document.createElement("canvas");
        scratch_context = scratch_canvas.getContext("2d");
    }
    /* The scaled copy goes below the image on the same canvas, so the
       canvas must hold both: rows of the copy past the canvas edge read
       back as transparent black. */
    if (scratch_canvas.width < Math.max(w, image_data.width))
        scratch_canvas.width = Math.max(w, image_data.width);
    if (scratch_canvas.height < image_data.height + h)
        scratch_canvas.height = image_data.height + h;
    scratch_context.putImageData(image_data, 0, 0);
    scratch_context.drawImage(scratch_canvas, src.left, src.top, sw, sh, 0, image_data.height, w, h);
    return { image_data: scratch_context.getImageData(0, image_data.height, w, h), src: { left: 0, top: 0, right: w, bottom: h } };
}

/* JPEG frames used to be turned into percent-encoded data: URIs one byte at
   a time — an O(n) string build per frame that dominated MJPEG playback.
   A Blob URL hands the bytes to the decoder directly; it must be revoked
   once the image has loaded (or failed) or each frame leaks its blob. */
function jpeg_image_url(data)
{
    return URL.createObjectURL(new Blob([data], { type: "image/jpeg" }));
}

function revoke_jpeg_image_url(img)
{
    if (img.src && img.src.startsWith("blob:"))
        URL.revokeObjectURL(img.src);
}

function handle_draw_jpeg_onerror()
{
    revoke_jpeg_image_url(this);
    if (this.o.sc.streams && this.o.sc.streams[this.o.id])
        this.o.sc.streams[this.o.id].frames_loading--;
    /* An image that will never decode must not hold the queue. */
    this.o.sc.mark_ready(this.o.op, null);
}

/*----------------------------------------------------------------------------
**  SpiceDisplayConn
**      Drive the Spice Display Channel
**--------------------------------------------------------------------------*/
function SpiceDisplayConn()
{
    SpiceConn.apply(this, arguments);
    this.ops = [];
}

SpiceDisplayConn.prototype = Object.create(SpiceConn.prototype);

/*----------------------------------------------------------------------------
**  Draw queue
**      Every drawing message becomes an op on one in-order queue, and a
**      draw that decodes asynchronously (JPEG) holds the ops behind it
**      until it is ready, so what the server sent after the JPEG lands
**      after the JPEG. The queue is drained from a microtask at the end
**      of the task that filled it, which is the websocket message: no
**      added latency and no extra task per frame (a drain per animation
**      frame cost 0.5 ms of task time per MJPEG frame). A drain spends
**      at most FLUSH_BUDGET_MS and hands the rest to an animation frame
**      so input stays responsive under a burst; a timer stands in for
**      the frame in a hidden tab.
**--------------------------------------------------------------------------*/
var FLUSH_BUDGET_MS = 8;
var FLUSH_FALLBACK_MS = 100;

SpiceDisplayConn.prototype.enqueue = function(draw)
{
    var op = { ready: true, draw: draw };
    this.ops.push(op);
    this.schedule_flush();
    return op;
}

/* An op whose draw is not known yet; mark_ready() supplies it. One that
   is still not ready after STALE_OP_MS is skipped by the drain, so a
   decoder that swallows a frame cannot hold the queue for good. */
var STALE_OP_MS = 2000;

SpiceDisplayConn.prototype.enqueue_pending = function()
{
    var op = { ready: false, draw: null, since: performance.now() };
    this.ops.push(op);
    /* The drain stops at this op and arms the stale check for it. */
    this.schedule_flush();
    return op;
}

SpiceDisplayConn.prototype.mark_ready = function(op, draw)
{
    op.draw = draw;
    op.ready = true;
    this.schedule_flush();
}

SpiceDisplayConn.prototype.schedule_flush = function()
{
    if (this.flush_frame !== undefined || this.flush_micro)
        return;
    var sc = this;
    this.flush_micro = true;
    Promise.resolve().then(function() { sc.flush_micro = false; if (sc.flush_frame === undefined) sc.flush(FLUSH_BUDGET_MS); });
}

SpiceDisplayConn.prototype.schedule_frame = function()
{
    if (this.flush_frame !== undefined)
        return;
    var sc = this;
    this.flush_frame = window.requestAnimationFrame(function() { sc.flush(FLUSH_BUDGET_MS); });
    this.flush_timer = window.setTimeout(function() { sc.flush(FLUSH_BUDGET_MS); }, FLUSH_FALLBACK_MS);
}

SpiceDisplayConn.prototype.cancel_flush = function()
{
    if (this.flush_frame !== undefined)
    {
        window.cancelAnimationFrame(this.flush_frame);
        if (this.flush_timer !== undefined)
            window.clearTimeout(this.flush_timer);
        this.flush_frame = undefined;
        this.flush_timer = undefined;
    }
}

SpiceDisplayConn.prototype.flush = function(budget_ms)
{
    this.cancel_flush();
    var deadline = performance.now() + budget_ms;
    while (this.ops.length > 0 &&
           (this.ops[0].ready || performance.now() - this.ops[0].since > STALE_OP_MS))
    {
        var op = this.ops.shift();
        if (! op.ready)
        {
            this.log_warn("Skipping a draw that never became ready");
            if (op.on_stale)
                op.on_stale();
            continue;
        }
        if (op.draw)
            op.draw.call(this);
        if (performance.now() > deadline && this.ops.length > 0 && this.ops[0].ready)
        {
            this.schedule_frame();
            return;
        }
    }
    /* Nothing else will drain the queue while its head is not ready, so
       come back when that op would be stale. */
    if (this.ops.length > 0 && this.stale_timer === undefined)
    {
        var sc = this;
        var wait = Math.max(0, this.ops[0].since + STALE_OP_MS - performance.now()) + 1;
        this.stale_timer = window.setTimeout(function()
        {
            sc.stale_timer = undefined;
            sc.flush(FLUSH_BUDGET_MS);
        }, wait);
    }
}

/* Drain everything that can be drawn now. */
SpiceDisplayConn.prototype.flush_all = function()
{
    this.flush(Infinity);
}

SpiceDisplayConn.prototype.drop_queue = function()
{
    this.cancel_flush();
    if (this.stale_timer !== undefined)
    {
        window.clearTimeout(this.stale_timer);
        this.stale_timer = undefined;
    }
    for (var i = 0; i < this.ops.length; i++)
        if (this.ops[i].release)
            this.ops[i].release();
    this.ops = [];
}

/* Whether a surface captured when an op was queued is still the live
   one: a queued draw for a surface destroyed and recreated since is moot. */
SpiceDisplayConn.prototype.surface_live = function(surface)
{
    return surface !== undefined && this.surfaces !== undefined &&
           this.surfaces[surface.surface_id] === surface;
}

SpiceDisplayConn.prototype.cleanup = function()
{
    this.drop_queue();
    SpiceConn.prototype.cleanup.call(this);
}
SpiceDisplayConn.prototype.process_channel_message = function(msg)
{
    if (msg.type == Constants.SPICE_MSG_DISPLAY_MODE)
    {
        this.known_unimplemented(msg.type, "Display Mode");
        return true;
    }

    if (msg.type == Constants.SPICE_MSG_DISPLAY_MARK)
    {
        /* The server saying the primary surface now holds a complete
           image and may be shown. A client that renders offscreen
           until then reveals its canvas here; this one draws straight
           into a canvas that is already visible, so the surface has
           been on screen all along and there is nothing to reveal.
           Nothing to do, and not a gap in the implementation. */
        return true;
    }

    if (msg.type == Constants.SPICE_MSG_DISPLAY_RESET)
    {
        Utils.DEBUG > 2 && console.log("Display reset");
        var reset_surface = this.surfaces[this.primary_surface];
        this.enqueue(function()
        {
            if (this.surface_live(reset_surface))
                reset_surface.canvas.context.restore();
        });
        return true;
    }

    if (msg.type == Constants.SPICE_MSG_DISPLAY_DRAW_COPY || msg.type == Constants.SPICE_MSG_DISPLAY_DRAW_BLEND)
    {
        /* Blend is a copy with a rop between source and destination. */
        var draw_copy = new Messages.SpiceMsgDisplayDrawCopy(msg.data);

        Utils.DEBUG > 1 && this.log_draw("DrawCopy", draw_copy);

        var copy_rop = ropd_to_rop(draw_copy.data.rop_descriptor, ROP_INPUT_SRC, ROP_INPUT_DEST);
        if (copy_rop == ROP.NOOP)
            return true;
        var copy_mask = this.decode_mask("DrawCopy", draw_copy.data.mask);

        if (draw_copy.data && draw_copy.data.src_bitmap)
        {
            if (draw_copy.data.src_bitmap.descriptor.flags &
                ~(Constants.SPICE_IMAGE_FLAGS_CACHE_ME | Constants.SPICE_IMAGE_FLAGS_HIGH_BITS_SET))
            {
                this.log_warn("FIXME: DrawCopy unhandled image flags: " + draw_copy.data.src_bitmap.descriptor.flags);
                Utils.DEBUG <= 1 && this.log_draw("DrawCopy", draw_copy);
            }

            if (draw_copy.data.src_bitmap.descriptor.type == Constants.SPICE_IMAGE_TYPE_QUIC)
            {
                var canvas = this.surfaces[draw_copy.base.surface_id].canvas;
                if (! draw_copy.data.src_bitmap.quic)
                {
                    this.log_warn("FIXME: DrawCopy could not handle this QUIC file.");
                    return false;
                }
                var source_img = Quic.convert_spice_quic_to_web(canvas.context,
                                        draw_copy.data.src_bitmap.quic);

                return this.draw_copy_helper(
                    { base: draw_copy.base, rop: copy_rop, mask: copy_mask,
                      src_area: draw_copy.data.src_area,
                      image_data: source_img,
                      tag: "copyquic." + draw_copy.data.src_bitmap.quic.type,
                      has_alpha: (draw_copy.data.src_bitmap.quic.type == Quic.Constants.QUIC_IMAGE_TYPE_RGBA ? true : false) ,
                      descriptor : draw_copy.data.src_bitmap.descriptor,
                      scale_mode : draw_copy.data.scale_mode
                    });
            }
            else if (draw_copy.data.src_bitmap.descriptor.type == Constants.SPICE_IMAGE_TYPE_FROM_CACHE ||
                    draw_copy.data.src_bitmap.descriptor.type == Constants.SPICE_IMAGE_TYPE_FROM_CACHE_LOSSLESS)
            {
                /* A cached JPEG is stored when its draw runs, which may be
                   after this message arrives; an image not in the cache
                   yet is looked up again when this op's turn comes. */
                var cache_id = draw_copy.data.src_bitmap.descriptor.id;
                var sc = this;
                return this.draw_copy_helper(
                    { base: draw_copy.base, rop: copy_rop, mask: copy_mask,
                      src_area: draw_copy.data.src_area,
                      image_data: this.cache ? this.cache[cache_id] : undefined,
                      resolve: function()
                      {
                          if (sc.cache && sc.cache[cache_id])
                              return sc.cache[cache_id];
                          sc.log_warn("FIXME: DrawCopy did not find image id " + cache_id + " in cache.");
                          return undefined;
                      },
                      tag: "copycache." + cache_id,
                      has_alpha: true, /* FIXME - may want this to be false... */
                      descriptor : draw_copy.data.src_bitmap.descriptor,
                      scale_mode : draw_copy.data.scale_mode
                    });

                /* FIXME - LOSSLESS CACHE ramifications not understood or handled */
            }
            else if (draw_copy.data.src_bitmap.descriptor.type == Constants.SPICE_IMAGE_TYPE_SURFACE)
            {
                var source_surface = this.surfaces[draw_copy.data.src_bitmap.surface_id];
                var src_area = draw_copy.data.src_area;
                var computed_src_area = new SpiceRect;
                computed_src_area.top = computed_src_area.left = 0;
                computed_src_area.right = src_area.right - src_area.left;
                computed_src_area.bottom = src_area.bottom - src_area.top;
                var sc = this;

                /* FIXME - there is a potential optimization here.
                           That is, if the surface is from 0,0, and
                           both surfaces are alpha surfaces, you should
                           be able to just do a drawImage, which should
                           save time.  */

                /* The source is read when this op runs, after everything
                   queued for it has been drawn. */
                return this.draw_copy_helper(
                    { base: draw_copy.base, rop: copy_rop, mask: copy_mask,
                      src_area: computed_src_area,
                      resolve: function()
                      {
                          if (! sc.surface_live(source_surface))
                              return undefined;
                          return source_surface.canvas.context.getImageData(
                              src_area.left, src_area.top,
                              computed_src_area.right, computed_src_area.bottom);
                      },
                      tag: "copysurf." + draw_copy.data.src_bitmap.surface_id,
                      has_alpha: source_surface.format != Constants.SPICE_SURFACE_FMT_32_xRGB,
                      descriptor : draw_copy.data.src_bitmap.descriptor,
                      scale_mode : draw_copy.data.scale_mode
                    });
            }
            else if (draw_copy.data.src_bitmap.descriptor.type == Constants.SPICE_IMAGE_TYPE_JPEG)
            {
                if (! draw_copy.data.src_bitmap.jpeg)
                {
                    this.log_warn("FIXME: DrawCopy could not handle this JPEG file.");
                    return false;
                }

                var img = new Image;
                img.o =
                    { base: draw_copy.base, rop: copy_rop, mask: copy_mask,
                      tag: "jpeg." + draw_copy.data.src_bitmap.surface_id,
                      descriptor : draw_copy.data.src_bitmap.descriptor,
                      sc : this,
                      surface : this.surfaces[draw_copy.base.surface_id],
                      op : this.enqueue_pending(),
                      src_area : draw_copy.data.src_area,
                      scale_mode : draw_copy.data.scale_mode,
                    };
                img.onload = handle_draw_jpeg_onload;
                img.onerror = handle_draw_jpeg_onerror;
                img.src = jpeg_image_url(draw_copy.data.src_bitmap.jpeg.data);

                return true;
            }
            else if (draw_copy.data.src_bitmap.descriptor.type == Constants.SPICE_IMAGE_TYPE_JPEG_ALPHA)
            {
                if (! draw_copy.data.src_bitmap.jpeg_alpha)
                {
                    this.log_warn("FIXME: DrawCopy could not handle this JPEG ALPHA file.");
                    return false;
                }

                var img = new Image;
                img.o =
                    { base: draw_copy.base, rop: copy_rop, mask: copy_mask,
                      tag: "jpeg." + draw_copy.data.src_bitmap.surface_id,
                      descriptor : draw_copy.data.src_bitmap.descriptor,
                      sc : this,
                      surface : this.surfaces[draw_copy.base.surface_id],
                      op : this.enqueue_pending(),
                      src_area : draw_copy.data.src_area,
                      scale_mode : draw_copy.data.scale_mode,
                    };

                if (this.surfaces[draw_copy.base.surface_id].format == Constants.SPICE_SURFACE_FMT_32_ARGB)
                {

                    var canvas = this.surfaces[draw_copy.base.surface_id].canvas;
                    img.alpha_img = convert_spice_lz_to_web(canvas.context,
                                            draw_copy.data.src_bitmap.jpeg_alpha.alpha);
                }
                img.onload = handle_draw_jpeg_onload;
                img.onerror = handle_draw_jpeg_onerror;
                img.src = jpeg_image_url(draw_copy.data.src_bitmap.jpeg_alpha.data);

                return true;
            }
            else if (draw_copy.data.src_bitmap.descriptor.type == Constants.SPICE_IMAGE_TYPE_BITMAP)
            {
                var canvas = this.surfaces[draw_copy.base.surface_id].canvas;
                if (! draw_copy.data.src_bitmap.bitmap)
                {
                    this.log_err("null bitmap");
                    return false;
                }

                var source_img = convert_spice_bitmap_to_web(canvas.context,
                                        draw_copy.data.src_bitmap.bitmap,
                                        this.bitmap_palette(draw_copy.data.src_bitmap.bitmap));
                if (! source_img)
                {
                    this.log_warn("FIXME: Unable to interpret bitmap of format: " +
                        draw_copy.data.src_bitmap.bitmap.format);
                    return false;
                }

                return this.draw_copy_helper(
                    { base: draw_copy.base, rop: copy_rop, mask: copy_mask,
                      src_area: draw_copy.data.src_area,
                      image_data: source_img,
                      tag: "bitmap." + draw_copy.data.src_bitmap.bitmap.format,
                      has_alpha: draw_copy.data.src_bitmap.bitmap.format == Constants.SPICE_BITMAP_FMT_RGBA ||
                                 draw_copy.data.src_bitmap.bitmap.format == Constants.SPICE_BITMAP_FMT_8BIT_A,
                      descriptor : draw_copy.data.src_bitmap.descriptor,
                      scale_mode : draw_copy.data.scale_mode
                    });
            }
            else if (draw_copy.data.src_bitmap.descriptor.type == Constants.SPICE_IMAGE_TYPE_LZ_RGB)
            {
                var canvas = this.surfaces[draw_copy.base.surface_id].canvas;
                if (! draw_copy.data.src_bitmap.lz_rgb)
                {
                    this.log_err("null lz_rgb ");
                    return false;
                }

                var source_img = convert_spice_lz_to_web(canvas.context,
                                            draw_copy.data.src_bitmap.lz_rgb);
                if (! source_img)
                {
                    this.log_warn("FIXME: Unable to interpret bitmap of type: " +
                        draw_copy.data.src_bitmap.lz_rgb.type);
                    return false;
                }

                return this.draw_copy_helper(
                    { base: draw_copy.base, rop: copy_rop, mask: copy_mask,
                      src_area: draw_copy.data.src_area,
                      image_data: source_img,
                      tag: "lz_rgb." + draw_copy.data.src_bitmap.lz_rgb.type,
                      has_alpha: draw_copy.data.src_bitmap.lz_rgb.type == Constants.LZ_IMAGE_TYPE_RGBA ||
                                 draw_copy.data.src_bitmap.lz_rgb.type == Constants.LZ_IMAGE_TYPE_A8,
                      descriptor : draw_copy.data.src_bitmap.descriptor,
                      scale_mode : draw_copy.data.scale_mode
                    });
            }
            else if (draw_copy.data.src_bitmap.descriptor.type == Constants.SPICE_IMAGE_TYPE_LZ4)
            {
                var canvas = this.surfaces[draw_copy.base.surface_id].canvas;
                if (! draw_copy.data.src_bitmap.lz4)
                {
                    this.log_err("null lz4");
                    return false;
                }

                var source_img = convert_spice_lz4_to_web(canvas.context,
                                            draw_copy.data.src_bitmap.descriptor,
                                            draw_copy.data.src_bitmap.lz4);
                if (! source_img)
                {
                    this.log_warn("FIXME: Unable to interpret lz4 image of " +
                        draw_copy.data.src_bitmap.lz4.data.byteLength + " bytes");
                    return false;
                }

                var lz4_format = new Uint8Array(draw_copy.data.src_bitmap.lz4.data)[1];
                return this.draw_copy_helper(
                    { base: draw_copy.base, rop: copy_rop, mask: copy_mask,
                      src_area: draw_copy.data.src_area,
                      image_data: source_img,
                      tag: "lz4." + lz4_format,
                      has_alpha: lz4_format == Constants.SPICE_BITMAP_FMT_RGBA,
                      descriptor : draw_copy.data.src_bitmap.descriptor,
                      scale_mode : draw_copy.data.scale_mode
                    });
            }
            else
            {
                this.log_warn("FIXME: DrawCopy unhandled image type: " + draw_copy.data.src_bitmap.descriptor.type);
                this.log_draw("DrawCopy", draw_copy);
                return false;
            }
        }

        this.log_warn("FIXME: DrawCopy no src_bitmap.");
        return false;
    }

    if (msg.type == Constants.SPICE_MSG_DISPLAY_DRAW_FILL)
    {
        var draw_fill = new Messages.SpiceMsgDisplayDrawFill(msg.data);

        Utils.DEBUG > 1 && this.log_draw("DrawFill", draw_fill);

        var fill_rop = draw_fill.data.rop_descriptor;
        if (fill_rop != Constants.SPICE_ROPD_OP_PUT && fill_rop != Constants.SPICE_ROPD_OP_XOR &&
            fill_rop != Constants.SPICE_ROPD_OP_BLACKNESS && fill_rop != Constants.SPICE_ROPD_OP_WHITENESS)
            this.log_warn("FIXME: DrawFill we don't handle ropd type: " + draw_fill.data.rop_descriptor);
        var fill_mask = this.decode_mask("DrawFill", draw_fill.data.mask);

        if (fill_rop == Constants.SPICE_ROPD_OP_BLACKNESS || fill_rop == Constants.SPICE_ROPD_OP_WHITENESS ||
            (draw_fill.data.brush.type == Constants.SPICE_BRUSH_TYPE_SOLID && (fill_rop == Constants.SPICE_ROPD_OP_XOR || fill_mask)))
        {
            /* Blackness and whiteness ignore the brush; xor inverts the
               destination through it (a white brush is the caret). */
            var rop_color = fill_rop == Constants.SPICE_ROPD_OP_BLACKNESS ? 0 :
                            fill_rop == Constants.SPICE_ROPD_OP_WHITENESS ? 0xffffff : draw_fill.data.brush.color & 0xffffff;
            var rop_surface = this.surfaces[draw_fill.base.surface_id];
            this.enqueue(function()
            {
                if (! this.surface_live(rop_surface))
                    return;
                var rects = clipped_rects(draw_fill.base.box, draw_fill.base.clip);
                var ctx = rop_surface.canvas.context;
                var xor = fill_rop == Constants.SPICE_ROPD_OP_XOR;
                if (fill_mask || xor)
                    combine_rects(ctx, draw_fill.base.box, rects, null, fill_mask, fill_tables(rop_color, xor));
                else
                {
                    ctx.fillStyle = rop_color ? "#ffffff" : "#000000";
                    for (var i = 0; i < rects.length; i++)
                        ctx.fillRect(rects[i].left, rects[i].top, rects[i].right - rects[i].left, rects[i].bottom - rects[i].top);
                }
                rop_surface.draw_count++;
            });
        }
        else if (draw_fill.data.brush.type == Constants.SPICE_BRUSH_TYPE_SOLID)
        {
            // FIXME - do brushes ever have alpha?
            var color = draw_fill.data.brush.color & 0xffffff;
            var color_str = brush_color(draw_fill.data.brush);
            var fill_surface = this.surfaces[draw_fill.base.surface_id];
            /* On an alpha surface the brush is an alpha value, written in place. */
            var alpha_fill = fill_surface.format == Constants.SPICE_SURFACE_FMT_8_A;

            this.enqueue(function()
            {
                if (! this.surface_live(fill_surface))
                    return;
                var fill_context = fill_surface.canvas.context;
                fill_context.save();
                if (alpha_fill)
                {
                    fill_context.globalCompositeOperation = "copy";
                    fill_context.fillStyle = "rgba(0, 0, 0, " + ((color & 0xff) / 255) + ")";
                }
                else
                    fill_context.fillStyle = color_str;

                with_clip(fill_context, draw_fill.base.clip, function()
                {
                    fill_context.fillRect(
                        draw_fill.base.box.left, draw_fill.base.box.top,
                        draw_fill.base.box.right - draw_fill.base.box.left,
                        draw_fill.base.box.bottom - draw_fill.base.box.top);
                });
                fill_context.restore();

                if (Utils.DUMP_DRAWS && this.parent.dump_id)
                {
                    var debug_canvas = document.createElement("canvas");
                    debug_canvas.setAttribute('width', fill_surface.canvas.width);
                    debug_canvas.setAttribute('height', fill_surface.canvas.height);
                    debug_canvas.setAttribute('id', "fillbrush." + draw_fill.base.surface_id + "." + fill_surface.draw_count);
                    debug_canvas.getContext("2d").fillStyle = color_str;
                    debug_canvas.getContext("2d").fillRect(
                        draw_fill.base.box.left, draw_fill.base.box.top,
                        draw_fill.base.box.right - draw_fill.base.box.left,
                        draw_fill.base.box.bottom - draw_fill.base.box.top);
                    document.getElementById(this.parent.dump_id).appendChild(debug_canvas);
                }

                fill_surface.draw_count++;
            });

        }
        else
        {
            this.log_warn("FIXME: DrawFill can't handle brush type: " + draw_fill.data.brush.type);
        }
        return true;
    }

    if (msg.type == Constants.SPICE_MSG_DISPLAY_DRAW_OPAQUE)
    {
        /* The source lands, then the brush is combined into it by the rop. */
        var opaque = new Messages.SpiceMsgDisplayDrawOpaque(msg.data);
        Utils.DEBUG > 1 && this.log_draw("DrawOpaque", opaque);
        if (! opaque.data.src_bitmap)
        {
            this.log_warn("FIXME: DrawOpaque no src_bitmap.");
            return false;
        }
        if (opaque.data.brush.type != Constants.SPICE_BRUSH_TYPE_SOLID)
        {
            this.log_warn("FIXME: DrawOpaque can't handle brush type: " + opaque.data.brush.type);
            return false;
        }
        var opaque_rop = ropd_to_rop(opaque.data.rop_descriptor, ROP_INPUT_BRUSH, ROP_INPUT_SRC);
        if (opaque_rop == ROP.NOOP)
            return true;
        var opaque_surface = this.surfaces[opaque.base.surface_id];
        var opaque_source = this.resolve_source_image("DrawOpaque", opaque.data.src_bitmap, opaque_surface.canvas, opaque.data.src_area);
        if (! opaque_source)
            return false;
        var opaque_mask = this.decode_mask("DrawOpaque", opaque.data.mask);
        var opaque_tables = brush_tables(opaque_rop, opaque.data.brush.color);
        this.enqueue(function()
        {
            if (! this.surface_live(opaque_surface))
                return;
            var image_data = opaque_source.image_data || (opaque_source.resolve ? opaque_source.resolve() : undefined);
            if (! image_data)
                return;
            var src = opaque_source.whole ? { left: 0, top: 0, right: image_data.width, bottom: image_data.height } : opaque.data.src_area;
            combine_rects(opaque_surface.canvas.context, opaque.base.box, clipped_rects(opaque.base.box, opaque.base.clip),
                          source_for_box(image_data, src, opaque.base.box), opaque_mask, opaque_tables);
            opaque_surface.draw_count++;
        });
        return true;
    }

    if (msg.type == Constants.SPICE_MSG_DISPLAY_DRAW_BLACKNESS ||
        msg.type == Constants.SPICE_MSG_DISPLAY_DRAW_WHITENESS ||
        msg.type == Constants.SPICE_MSG_DISPLAY_DRAW_INVERS)
    {
        var plain = new Messages.SpiceMsgDisplayDrawMaskOnly(msg.data);
        var plain_type = msg.type;
        var plain_surface = this.surfaces[plain.base.surface_id];
        var plain_mask = this.decode_mask("DrawBlackness", plain.data.mask);
        this.enqueue(function()
        {
            if (! this.surface_live(plain_surface))
                return;
            var ctx = plain_surface.canvas.context;
            var rects = clipped_rects(plain.base.box, plain.base.clip);
            var plain_value = plain_type == Constants.SPICE_MSG_DISPLAY_DRAW_WHITENESS ? 255 : 0;
            var plain_invert = plain_type == Constants.SPICE_MSG_DISPLAY_DRAW_INVERS;
            /* On an alpha surface black is clear and white is opaque. */
            if (plain_surface.format == Constants.SPICE_SURFACE_FMT_8_A)
                combine_rects(ctx, plain.base.box, rects, null, plain_mask, alpha_only(dest_tables(plain_value, plain_invert)));
            else if (! plain_mask && ! plain_invert)
            {
                ctx.fillStyle = plain_type == Constants.SPICE_MSG_DISPLAY_DRAW_WHITENESS ? "#ffffff" : "#000000";
                for (var i = 0; i < rects.length; i++)
                    ctx.fillRect(rects[i].left, rects[i].top, rects[i].right - rects[i].left, rects[i].bottom - rects[i].top);
            }
            else
            {
                combine_rects(ctx, plain.base.box, rects, null, plain_mask, dest_tables(plain_value, plain_invert));
            }
            plain_surface.draw_count++;
        });
        return true;
    }

    if (msg.type == Constants.SPICE_MSG_DISPLAY_DRAW_ROP3)
    {
        var rop3 = new Messages.SpiceMsgDisplayDrawRop3(msg.data);
        Utils.DEBUG > 1 && this.log_draw("DrawRop3", rop3);
        if (! rop3.data.src_bitmap)
        {
            this.log_warn("FIXME: DrawRop3 no src_bitmap.");
            return false;
        }
        if (rop3.data.brush.type != Constants.SPICE_BRUSH_TYPE_SOLID)
        {
            this.log_warn("FIXME: DrawRop3 can't handle brush type: " + rop3.data.brush.type);
            return false;
        }
        var rop3_surface = this.surfaces[rop3.base.surface_id];
        var rop3_source = this.resolve_source_image("DrawRop3", rop3.data.src_bitmap, rop3_surface.canvas, rop3.data.src_area);
        if (! rop3_source)
            return false;
        var rop3_mask = this.decode_mask("DrawRop3", rop3.data.mask);
        var code = rop3.data.rop3;
        var rop3_color = rop3.data.brush.color;
        this.enqueue(function()
        {
            if (! this.surface_live(rop3_surface))
                return;
            var image_data = rop3_source.image_data || (rop3_source.resolve ? rop3_source.resolve() : undefined);
            if (! image_data)
                return;
            var src = rop3_source.whole ? { left: 0, top: 0, right: image_data.width, bottom: image_data.height } : rop3.data.src_area;
            combine_rects(rop3_surface.canvas.context, rop3.base.box, clipped_rects(rop3.base.box, rop3.base.clip),
                          source_for_box(image_data, src, rop3.base.box), rop3_mask, rop3_tables(code, rop3_color));
            rop3_surface.draw_count++;
        });
        return true;
    }

    if (msg.type == Constants.SPICE_MSG_DISPLAY_DRAW_STROKE)
    {
        var stroke = new Messages.SpiceMsgDisplayDrawStroke(msg.data);
        Utils.DEBUG > 1 && this.log_draw("DrawStroke", stroke);
        var stroke_color = brush_color(stroke.data.brush);
        if (stroke_color === undefined)
        {
            this.log_warn("FIXME: DrawStroke can't handle brush type: " + stroke.data.brush.type);
            return false;
        }
        if (! stroke.data.path)
        {
            this.log_warn("FIXME: DrawStroke without a path");
            return false;
        }
        if (stroke.data.fore_mode != Constants.SPICE_ROPD_OP_PUT)
            this.log_warn("FIXME: DrawStroke we don't handle fore_mode: " + stroke.data.fore_mode);
        var stroke_surface = this.surfaces[stroke.base.surface_id];
        this.enqueue(function()
        {
            if (! this.surface_live(stroke_surface))
                return;
            var ctx = stroke_surface.canvas.context;
            ctx.save();
            with_clip(ctx, stroke.base.clip, function()
            {
                ctx.strokeStyle = stroke_color;
                ctx.lineWidth = 1;
                ctx.lineCap = "butt";
                if (stroke.data.attr.flags & Constants.SPICE_LINE_FLAGS_STYLED && stroke.data.attr.style.length)
                    ctx.setLineDash(stroke.data.attr.style);
                /* Pixel centres, so a one pixel line covers one pixel. */
                ctx.translate(0.5, 0.5);
                ctx.beginPath();
                var segs = stroke.data.path.segments;
                for (var s = 0; s < segs.length; s++)
                {
                    var pts = segs[s].points;
                    var p = 0;
                    if (segs[s].flags & Constants.SPICE_PATH_BEGIN && pts.length)
                    {
                        ctx.moveTo(pts[0].x, pts[0].y);
                        p = 1;
                    }
                    if (segs[s].flags & Constants.SPICE_PATH_BEZIER)
                        for (; p + 2 < pts.length; p += 3)
                            ctx.bezierCurveTo(pts[p].x, pts[p].y, pts[p + 1].x, pts[p + 1].y, pts[p + 2].x, pts[p + 2].y);
                    else
                        for (; p < pts.length; p++)
                            ctx.lineTo(pts[p].x, pts[p].y);
                    if ((segs[s].flags & Constants.SPICE_PATH_END) && (segs[s].flags & Constants.SPICE_PATH_CLOSE))
                        ctx.closePath();
                }
                ctx.stroke();
            });
            ctx.restore();
            stroke_surface.draw_count++;
        });
        return true;
    }

    if (msg.type == Constants.SPICE_MSG_DISPLAY_DRAW_TEXT)
    {
        var text = new Messages.SpiceMsgDisplayDrawText(msg.data);
        Utils.DEBUG > 1 && this.log_draw("DrawText", text);
        if (! text.data.str)
        {
            this.log_warn("FIXME: DrawText without a string");
            return false;
        }
        if (text.data.fore_mode != Constants.SPICE_ROPD_OP_PUT || text.data.back_mode != Constants.SPICE_ROPD_OP_PUT)
            this.log_warn("FIXME: DrawText we don't handle rop modes " + text.data.fore_mode + "/" + text.data.back_mode);
        if (text.data.fore_brush.type != Constants.SPICE_BRUSH_TYPE_SOLID)
        {
            this.log_warn("FIXME: DrawText can't handle fore brush type: " + text.data.fore_brush.type);
            return false;
        }
        var back_area = text.data.back_area;
        var back_empty = back_area.right <= back_area.left || back_area.bottom <= back_area.top;
        var back_color = brush_color(text.data.back_brush);
        if (! back_empty && back_color === undefined)
            this.log_warn("FIXME: DrawText can't handle back brush type: " + text.data.back_brush.type);
        var mask = render_string_mask(text.data.str, text.data.fore_brush.color);
        var text_surface = this.surfaces[text.base.surface_id];
        this.enqueue(function()
        {
            if (! this.surface_live(text_surface))
                return;
            var ctx = text_surface.canvas.context;
            with_clip(ctx, text.base.clip, function()
            {
                if (! back_empty && back_color !== undefined)
                {
                    ctx.fillStyle = back_color;
                    ctx.fillRect(back_area.left, back_area.top, back_area.right - back_area.left, back_area.bottom - back_area.top);
                }
                if (mask)
                    putImageDataWithAlpha(ctx, mask.image_data, mask.left, mask.top,
                                          { left: 0, top: 0, right: mask.width, bottom: mask.height }, mask.width, mask.height);
            });
            text_surface.draw_count++;
        });
        return true;
    }

    if (msg.type == Constants.SPICE_MSG_DISPLAY_DRAW_TRANSPARENT)
    {
        /* A copy that skips pixels of the key colour. */
        var transparent = new Messages.SpiceMsgDisplayDrawTransparent(msg.data);
        Utils.DEBUG > 1 && this.log_draw("DrawTransparent", transparent);
        if (! transparent.data.src_bitmap)
        {
            this.log_warn("FIXME: DrawTransparent no src_bitmap.");
            return false;
        }
        var tr_surface = this.surfaces[transparent.base.surface_id];
        var tr_source = this.resolve_source_image("DrawTransparent", transparent.data.src_bitmap, tr_surface.canvas, transparent.data.src_area);
        if (! tr_source)
            return false;
        var key = transparent.data.true_color & 0xffffff;
        this.enqueue(function()
        {
            if (! this.surface_live(tr_surface))
                return;
            var image_data = tr_source.image_data || (tr_source.resolve ? tr_source.resolve() : undefined);
            if (! image_data)
                return;
            var box = transparent.base.box;
            var area = tr_source.whole ? { left: 0, top: 0, right: image_data.width, bottom: image_data.height } : transparent.data.src_area;
            /* Only the part that lands in the box is keyed: the source may
               be a whole cached sheet of which this draw takes an icon. */
            var kw = area.right - area.left, kh = area.bottom - area.top;
            var keyed = new ImageData(kw, kh);
            var p = keyed.data, q = image_data.data;
            for (var y = 0, o = 0; y < kh; y++)
            {
                var qi = ((area.top + y) * image_data.width + area.left) * 4;
                for (var x = 0; x < kw; x++, o += 4, qi += 4)
                {
                    p[o] = q[qi];
                    p[o + 1] = q[qi + 1];
                    p[o + 2] = q[qi + 2];
                    p[o + 3] = ((q[qi] << 16) | (q[qi + 1] << 8) | q[qi + 2]) == key ? 0 : 255;
                }
            }
            var src = { left: 0, top: 0, right: kw, bottom: kh };
            var ctx = tr_surface.canvas.context;
            with_clip(ctx, transparent.base.clip, function()
            {
                putImageDataWithAlpha(ctx, keyed, box.left, box.top, src, box.right - box.left, box.bottom - box.top);
            });
            tr_surface.draw_count++;
        });
        return true;
    }

    if (msg.type == Constants.SPICE_MSG_DISPLAY_DRAW_ALPHA_BLEND)
    {
        var blend = new Messages.SpiceMsgDisplayDrawAlphaBlend(msg.data);
        Utils.DEBUG > 1 && this.log_draw("DrawAlphaBlend", blend);
        if (! blend.data.src_bitmap)
        {
            this.log_warn("FIXME: DrawAlphaBlend no src_bitmap.");
            return false;
        }
        var blend_surface = this.surfaces[blend.base.surface_id];
        var source = this.resolve_source_image("DrawAlphaBlend", blend.data.src_bitmap, blend_surface.canvas, blend.data.src_area);
        if (! source)
            return false;
        var alpha = blend.data.alpha / 255;
        this.enqueue(function()
        {
            if (! this.surface_live(blend_surface))
                return;
            var image_data = source.image_data || (source.resolve ? source.resolve() : undefined);
            if (! image_data || alpha == 0)
                return;
            var ctx = blend_surface.canvas.context;
            var box = blend.base.box;
            var w = box.right - box.left, h = box.bottom - box.top;
            var src = source.whole ? { left: 0, top: 0, right: image_data.width, bottom: image_data.height } : blend.data.src_area;
            ctx.globalAlpha = alpha;
            with_clip(ctx, blend.base.clip, function()
            {
                putImageDataWithAlpha(ctx, image_data, box.left, box.top, src, w, h);
            });
            ctx.globalAlpha = 1;
            blend_surface.draw_count++;
        });
        return true;
    }

    if (msg.type == Constants.SPICE_MSG_DISPLAY_COPY_BITS)
    {
        var copy_bits = new Messages.SpiceMsgDisplayCopyBits(msg.data);

        Utils.DEBUG > 1 && this.log_draw("CopyBits", copy_bits);

        var copy_surface = this.surfaces[copy_bits.base.surface_id];

        this.enqueue(function()
        {
            if (! this.surface_live(copy_surface))
                return;
            var source_canvas = copy_surface.canvas;
            var source_context = source_canvas.context;

            var width = source_canvas.width - copy_bits.src_pos.x;
            var height = source_canvas.height - copy_bits.src_pos.y;
            if (width > (copy_bits.base.box.right - copy_bits.base.box.left))
                width = copy_bits.base.box.right - copy_bits.base.box.left;
            if (height > (copy_bits.base.box.bottom - copy_bits.base.box.top))
                height = copy_bits.base.box.bottom - copy_bits.base.box.top;

            /* drawImage from a canvas onto itself snapshots the source rect
               first (per the 2D canvas spec), so this replaces a getImageData
               round-trip — a full GPU->CPU sync readback per scroll — with a
               blit that stays on the GPU. */
            with_clip(source_context, copy_bits.base.clip, function()
            {
                source_context.drawImage(source_canvas,
                        copy_bits.src_pos.x, copy_bits.src_pos.y, width, height,
                        copy_bits.base.box.left, copy_bits.base.box.top, width, height);
            });

            if (Utils.DUMP_DRAWS && this.parent.dump_id)
            {
                var debug_canvas = document.createElement("canvas");
                debug_canvas.setAttribute('width', width);
                debug_canvas.setAttribute('height', height);
                debug_canvas.setAttribute('id', "copybits" + copy_bits.base.surface_id + "." + copy_surface.draw_count);
                debug_canvas.getContext("2d").drawImage(source_canvas,
                    copy_bits.base.box.left, copy_bits.base.box.top, width, height,
                    0, 0, width, height);
                document.getElementById(this.parent.dump_id).appendChild(debug_canvas);
            }

            copy_surface.draw_count++;
        });
        return true;
    }

    if (msg.type == Constants.SPICE_MSG_DISPLAY_INVAL_ALL_PIXMAPS)
    {
        this.known_unimplemented(msg.type, "Display Inval All Pixmaps");
        return true;
    }

    if (msg.type == Constants.SPICE_MSG_DISPLAY_INVAL_PALETTE)
    {
        var inval = new Messages.SpiceMsgDisplayInvalPalette(msg.data);
        if (this.palette_cache)
            delete this.palette_cache[String(inval.id)];
        return true;
    }

    if (msg.type == Constants.SPICE_MSG_DISPLAY_INVAL_ALL_PALETTES)
    {
        this.palette_cache = undefined;
        return true;
    }

    if (msg.type == Constants.SPICE_MSG_DISPLAY_SURFACE_CREATE)
    {
        if (! ("surfaces" in this))
            this.surfaces = [];

        var m = new Messages.SpiceMsgSurfaceCreate(msg.data);
        Utils.DEBUG > 1 && console.log(this.type + ": MsgSurfaceCreate id " + m.surface.surface_id
                                    + "; " + m.surface.width + "x" + m.surface.height
                                    + "; format " + m.surface.format
                                    + "; flags " + m.surface.flags);
        if (m.surface.format != Constants.SPICE_SURFACE_FMT_32_xRGB &&
            m.surface.format != Constants.SPICE_SURFACE_FMT_32_ARGB &&
            m.surface.format != Constants.SPICE_SURFACE_FMT_8_A)
        {
            this.log_warn("FIXME: cannot handle surface format " + m.surface.format + " yet.");
            return false;
        }

        var canvas = document.createElement("canvas");
        canvas.setAttribute('width', m.surface.width);
        canvas.setAttribute('height', m.surface.height);
        canvas.setAttribute('id', "spice_surface_" + m.surface.surface_id);
        canvas.setAttribute('tabindex', m.surface.surface_id);
        canvas.context = canvas.getContext("2d");

        /* A fresh canvas is fully transparent; a real SPICE client presents a
           black framebuffer. Without this, regions the guest never draws
           (e.g. during firmware boot) show the page background through. */
        canvas.context.fillStyle = "black";
        canvas.context.fillRect(0, 0, m.surface.width, m.surface.height);

        if (Utils.DUMP_CANVASES && this.parent.dump_id)
            document.getElementById(this.parent.dump_id).appendChild(canvas);

        m.surface.canvas = canvas;
        m.surface.draw_count = 0;
        this.surfaces[m.surface.surface_id] = m.surface;

        if (m.surface.flags & Constants.SPICE_SURFACE_FLAGS_PRIMARY)
        {
            this.primary_surface = m.surface.surface_id;

            /* This .save() is done entirely to enable SPICE_MSG_DISPLAY_RESET */
            canvas.context.save();
            document.getElementById(this.parent.screen_id).appendChild(canvas);

            /* We're going to leave width dynamic, but correctly set the height */
            document.getElementById(this.parent.screen_id).style.height = m.surface.height + "px";
            this.hook_events();
        }
        return true;
    }

    if (msg.type == Constants.SPICE_MSG_DISPLAY_SURFACE_DESTROY)
    {
        var m = new Messages.SpiceMsgSurfaceDestroy(msg.data);
        Utils.DEBUG > 1 && console.log(this.type + ": MsgSurfaceDestroy id " + m.surface_id);
        var doomed = this.surfaces ? this.surfaces[m.surface_id] : undefined;
        if (doomed === undefined)
            return true;
        this.enqueue(function()
        {
            if (this.surface_live(doomed))
                this.delete_surface(m.surface_id);
        });
        return true;
    }

    if (msg.type == Constants.SPICE_MSG_DISPLAY_STREAM_CREATE)
    {
        var m = new Messages.SpiceMsgDisplayStreamCreate(msg.data);
        Utils.STREAM_DEBUG > 0 && console.log(this.type + ": MsgStreamCreate id" + m.id + "; type " + m.codec_type +
                                        "; width " + m.stream_width + "; height " + m.stream_height +
                                        "; left " + m.dest.left + "; top " + m.dest.top
                                        );
        if (!this.streams)
            this.streams = new Array();
        if (this.streams[m.id])
            console.log("Stream " + m.id + " already exists");
        else
            this.streams[m.id] = m;

        var decoder_codec = video_decoder_codec(m.codec_type);
        if (decoder_codec !== undefined && typeof VideoDecoder !== "undefined")
        {
            create_stream_decoder(this, this.streams[m.id], decoder_codec);
        }
        else if (m.codec_type == Constants.SPICE_VIDEO_CODEC_TYPE_VP8)
        {
            var media = new MediaSource();
            var v = document.createElement("video");
            v.src = window.URL.createObjectURL(media);

            v.setAttribute('muted', true);
            v.setAttribute('autoplay', true);
            v.setAttribute('width', m.stream_width);
            v.setAttribute('height', m.stream_height);

            var left = m.dest.left;
            var top = m.dest.top;
            if (this.surfaces[m.surface_id] !== undefined)
            {
                left += this.surfaces[m.surface_id].canvas.offsetLeft;
                top += this.surfaces[m.surface_id].canvas.offsetTop;
            }
            document.getElementById(this.parent.screen_id).appendChild(v);
            v.setAttribute('style', "pointer-events:none; position: absolute; top:" + top + "px; left:" + left + "px;");
            if (! (m.flags & Constants.SPICE_STREAM_FLAGS_TOP_DOWN))
                v.style.transform = "scaleY(-1)";

            media.addEventListener('sourceopen', handle_video_source_open, false);
            media.addEventListener('sourceended', handle_video_source_ended, false);
            media.addEventListener('sourceclosed', handle_video_source_closed, false);

            var s = this.streams[m.id];
            s.video = v;
            s.media = media;
            s.queue = new Array();
            s.start_time = 0;
            s.cluster_time = 0;
            s.append_okay = false;

            media.stream = s;
            media.spiceconn = this;
            v.spice_stream = s;
            apply_video_clip(s);
        }
        else if (m.codec_type == Constants.SPICE_VIDEO_CODEC_TYPE_MJPEG)
            this.streams[m.id].frames_loading = 0;
        else
            console.log("Unhandled stream codec: "+m.codec_type);
        return true;
    }

    if (msg.type == Constants.SPICE_MSG_DISPLAY_STREAM_DATA ||
        msg.type == Constants.SPICE_MSG_DISPLAY_STREAM_DATA_SIZED)
    {
        var m;
        if (msg.type == Constants.SPICE_MSG_DISPLAY_STREAM_DATA_SIZED)
            m = new Messages.SpiceMsgDisplayStreamDataSized(msg.data);
        else
            m = new Messages.SpiceMsgDisplayStreamData(msg.data);

        if (!this.streams || !this.streams[m.base.id])
        {
            console.log("no stream for data");
            return false;
        }

        var time_until_due = m.base.multi_media_time - this.parent.relative_now();

        if (this.streams[m.base.id].decoder)
            process_decoder_stream_data(this, this.streams[m.base.id], m, time_until_due);
        else if (this.streams[m.base.id].codec_type === Constants.SPICE_VIDEO_CODEC_TYPE_MJPEG)
            process_mjpeg_stream_data(this, m, time_until_due);
        else if (this.streams[m.base.id].codec_type === Constants.SPICE_VIDEO_CODEC_TYPE_VP8)
            process_video_stream_data(this.streams[m.base.id], m);

        return true;
    }

    if (msg.type == Constants.SPICE_MSG_DISPLAY_STREAM_ACTIVATE_REPORT)
    {
        var m = new Messages.SpiceMsgDisplayStreamActivateReport(msg.data);

        var report = new Messages.SpiceMsgcDisplayStreamReport(m.stream_id, m.unique_id);
        if (this.streams && this.streams[m.stream_id])
        {
            this.streams[m.stream_id].report = report;
            this.streams[m.stream_id].max_window_size = m.max_window_size;
            this.streams[m.stream_id].timeout_ms = m.timeout_ms
        }

        return true;
    }

    if (msg.type == Constants.SPICE_MSG_DISPLAY_STREAM_CLIP)
    {
        var m = new Messages.SpiceMsgDisplayStreamClip(msg.data);
        Utils.STREAM_DEBUG > 1 && console.log(this.type + ": MsgStreamClip id" + m.id);
        /* A clip for a stream that was already destroyed must not throw:
           an exception in a handler desyncs the channel framing. */
        if (this.streams && this.streams[m.id])
        {
            this.streams[m.id].clip = m.clip;
            apply_video_clip(this.streams[m.id]);
        }
        return true;
    }

    if (msg.type == Constants.SPICE_MSG_DISPLAY_STREAM_DESTROY)
    {
        var m = new Messages.SpiceMsgDisplayStreamDestroy(msg.data);
        Utils.STREAM_DEBUG > 0 && console.log(this.type + ": MsgStreamDestroy id" + m.id);

        /* A destroy for an unknown or already-destroyed id must not throw:
           an exception here skips the wire reader's rearm and desyncs the
           channel framing for good. */
        if (this.streams && this.streams[m.id])
            this.destroy_stream(m.id);
        return true;
    }

    if (msg.type == Constants.SPICE_MSG_DISPLAY_STREAM_DESTROY_ALL)
    {
        for (var sid in this.streams)
            if (this.streams[sid])
                this.destroy_stream(sid);
        return true;
    }

    if (msg.type == Constants.SPICE_MSG_DISPLAY_INVAL_LIST)
    {
        var m = new Messages.SpiceMsgDisplayInvalList(msg.data);
        var i;
        Utils.DEBUG > 1 && console.log(this.type + ": MsgInvalList " + m.count + " items");
        for (i = 0; i < m.count; i++)
            if (this.cache && this.cache[m.resources[i].id] != undefined)
                delete this.cache[m.resources[i].id];
        return true;
    }

    if (msg.type == Constants.SPICE_MSG_DISPLAY_MONITORS_CONFIG)
    {
        this.known_unimplemented(msg.type, "Display Monitors Config");
        return true;
    }

    if (msg.type == Constants.SPICE_MSG_DISPLAY_DRAW_COMPOSITE)
    {
        var composite = new Messages.SpiceMsgDisplayDrawComposite(msg.data);
        Utils.DEBUG > 1 && this.log_draw("DrawComposite", composite);
        if (! composite.data.src_bitmap)
        {
            this.log_warn("FIXME: DrawComposite no src_bitmap.");
            return false;
        }
        var comp_surface = this.surfaces[composite.base.surface_id];
        var comp_box = composite.base.box;
        var comp_w = comp_box.right - comp_box.left, comp_h = comp_box.bottom - comp_box.top;
        var comp_area = { left: 0, top: 0, right: comp_w, bottom: comp_h };
        /* A surface operand is read at its origin, so the layer starts at 0. */
        var origin_area = function(o) { return { left: o.x, top: o.y, right: o.x + comp_w, bottom: o.y + comp_h }; };
        var src_is_surface = composite.data.src_bitmap.descriptor.type == Constants.SPICE_IMAGE_TYPE_SURFACE;
        var comp_src = this.resolve_source_image("DrawComposite", composite.data.src_bitmap, comp_surface.canvas,
                                                 src_is_surface ? origin_area(composite.data.src_origin) : comp_area);
        if (! comp_src)
            return false;
        var src_origin = src_is_surface ? { x: 0, y: 0 } : composite.data.src_origin;
        var comp_mask = null;
        var mask_origin = composite.data.mask_origin;
        if (composite.data.mask_bitmap)
        {
            var mask_is_surface = composite.data.mask_bitmap.descriptor.type == Constants.SPICE_IMAGE_TYPE_SURFACE;
            comp_mask = this.resolve_source_image("DrawComposite mask", composite.data.mask_bitmap, comp_surface.canvas,
                                                  mask_is_surface ? origin_area(mask_origin) : comp_area);
            if (! comp_mask)
                return false;
            if (mask_is_surface)
                mask_origin = { x: 0, y: 0 };
        }
        var op = COMPOSITE_OPS[composite.data.flags & Constants.SPICE_COMPOSITE_OP_MASK];
        if (op === undefined)
        {
            this.log_warn("FIXME: DrawComposite op " + (composite.data.flags & Constants.SPICE_COMPOSITE_OP_MASK) + " not handled");
            return false;
        }
        var comp_data = composite.data;
        this.enqueue(function()
        {
            if (! this.surface_live(comp_surface))
                return;
            var src_image = comp_src.image_data || (comp_src.resolve ? comp_src.resolve() : undefined);
            if (! src_image)
                return;
            var w = comp_area.right, h = comp_area.bottom;
            var layer = composite_layer(0, src_image, src_origin, comp_data.src_transform,
                                        (comp_data.flags >> Constants.SPICE_COMPOSITE_SRC_REPEAT_SHIFT) & 3,
                                        (comp_data.flags >> Constants.SPICE_COMPOSITE_SRC_FILTER_SHIFT) & 7, w, h);
            if (comp_mask)
            {
                var mask_image = comp_mask.image_data || (comp_mask.resolve ? comp_mask.resolve() : undefined);
                if (mask_image)
                {
                    var mask_layer = composite_layer(1, mask_image, mask_origin, comp_data.mask_transform,
                                                     (comp_data.flags >> Constants.SPICE_COMPOSITE_MASK_REPEAT_SHIFT) & 3,
                                                     (comp_data.flags >> Constants.SPICE_COMPOSITE_MASK_FILTER_SHIFT) & 7, w, h);
                    var lctx = layer.getContext("2d");
                    lctx.globalCompositeOperation = "destination-in";
                    lctx.drawImage(mask_layer, 0, 0, w, h, 0, 0, w, h);
                    lctx.globalCompositeOperation = "source-over";
                }
            }
            var ctx = comp_surface.canvas.context;
            ctx.save();
            ctx.beginPath();
            var rects = clipped_rects(comp_box, composite.base.clip);
            for (var i = 0; i < rects.length; i++)
                ctx.rect(rects[i].left, rects[i].top, rects[i].right - rects[i].left, rects[i].bottom - rects[i].top);
            ctx.clip();
            if (op == "clear")
                ctx.clearRect(comp_box.left, comp_box.top, w, h);
            else if (op != "dst")
            {
                ctx.globalCompositeOperation = op;
                ctx.drawImage(layer, 0, 0, w, h, comp_box.left, comp_box.top, w, h);
            }
            ctx.restore();
            comp_surface.draw_count++;
        });
        return true;
    }

    return false;
}

SpiceDisplayConn.prototype.delete_surface = function(surface_id)
{
    var canvas = document.getElementById("spice_surface_" + surface_id);
    if (Utils.DUMP_CANVASES && this.parent.dump_id)
        document.getElementById(this.parent.dump_id).removeChild(canvas);
    if (this.primary_surface == surface_id)
    {
        this.unhook_events();
        this.primary_surface = undefined;
        document.getElementById(this.parent.screen_id).removeChild(canvas);
    }

    delete this.surfaces[surface_id];
}


/* A draw's source image for ops that blend rather than copy: the same
   decoders as the DrawCopy branches, minus the JPEG kinds, which decode
   asynchronously.  Returns { image_data } for an image decoded now,
   { resolve } for a cache or surface read when the op runs (a surface
   read covers src_area, so `whole` says to use all of it), or undefined
   with a warning.  A cacheable image goes into the cache now, as
   draw_copy_helper does. */
/* The palette a palettised bitmap wants: its own, remembered when it
   asks, or one remembered earlier. */
SpiceDisplayConn.prototype.bitmap_palette = function(bitmap)
{
    if (bitmap.flags & Constants.SPICE_BITMAP_FLAGS_PAL_FROM_CACHE)
    {
        var ents = this.palette_cache ? this.palette_cache[String(bitmap.palette_id)] : undefined;
        if (! ents)
            this.log_warn("FIXME: palette " + bitmap.palette_id + " not in cache");
        return ents;
    }
    if (! bitmap.palette)
        return undefined;
    if (bitmap.flags & Constants.SPICE_BITMAP_FLAGS_PAL_CACHE_ME)
    {
        if (! this.palette_cache)
            this.palette_cache = {};
        this.palette_cache[String(bitmap.palette.unique)] = bitmap.palette.ents;
    }
    return bitmap.palette.ents;
}

/* A draw's mask as { bits, width, height, pos }, or undefined when there
   is none or it is not a 1-bit bitmap. */
SpiceDisplayConn.prototype.decode_mask = function(tag, qmask)
{
    if (! qmask || ! qmask.bitmap)
        return undefined;
    var image = qmask.bitmap;
    var mask = image.descriptor.type == Constants.SPICE_IMAGE_TYPE_BITMAP && image.bitmap ?
               convert_spice_mask(image.bitmap, qmask.flags & Constants.SPICE_MASK_FLAGS_INVERS) : undefined;
    if (! mask)
    {
        this.log_warn("FIXME: " + tag + " mask of image type " + image.descriptor.type +
                      (image.bitmap ? " format " + image.bitmap.format : "") + " not handled");
        return undefined;
    }
    mask.pos = qmask.pos;
    return mask;
}

SpiceDisplayConn.prototype.resolve_source_image = function(tag, image, canvas, src_area)
{
    var d = image.descriptor;
    var sc = this;
    var out;
    switch (d.type)
    {
        case Constants.SPICE_IMAGE_TYPE_QUIC:
            if (! image.quic)
                break;
            out = { image_data: Quic.convert_spice_quic_to_web(canvas.context, image.quic) };
            break;
        case Constants.SPICE_IMAGE_TYPE_BITMAP:
            if (image.bitmap)
                out = { image_data: convert_spice_bitmap_to_web(canvas.context, image.bitmap, this.bitmap_palette(image.bitmap)) };
            break;
        case Constants.SPICE_IMAGE_TYPE_LZ_RGB:
            if (image.lz_rgb)
                out = { image_data: convert_spice_lz_to_web(canvas.context, image.lz_rgb) };
            break;
        case Constants.SPICE_IMAGE_TYPE_LZ4:
            if (image.lz4)
                out = { image_data: convert_spice_lz4_to_web(canvas.context, d, image.lz4) };
            break;
        case Constants.SPICE_IMAGE_TYPE_FROM_CACHE:
        case Constants.SPICE_IMAGE_TYPE_FROM_CACHE_LOSSLESS:
            out = { resolve: function()
                    {
                        if (sc.cache && sc.cache[d.id])
                            return sc.cache[d.id];
                        sc.log_warn("FIXME: " + tag + " did not find image id " + d.id + " in cache.");
                        return undefined;
                    } };
            break;
        case Constants.SPICE_IMAGE_TYPE_SURFACE:
            var source_surface = this.surfaces[image.surface_id];
            out = { whole: true, resolve: function()
                    {
                        if (! sc.surface_live(source_surface))
                            return undefined;
                        return source_surface.canvas.context.getImageData(src_area.left, src_area.top,
                                    src_area.right - src_area.left, src_area.bottom - src_area.top);
                    } };
            break;
    }
    if (! out || (! out.image_data && ! out.resolve))
    {
        this.log_warn("FIXME: " + tag + " unhandled image type: " + d.type);
        return undefined;
    }
    if (out.image_data && (d.flags & Constants.SPICE_IMAGE_FLAGS_CACHE_ME))
    {
        if (! ("cache" in this))
            this.cache = {};
        this.cache[d.id] = out.image_data;
    }
    return out;
}

SpiceDisplayConn.prototype.draw_copy_helper = function(o)
{
    o.surface = this.surfaces[o.base.surface_id];

    /* FIXME - This is based on trial + error, not a serious thoughtful
               analysis of what Spice requires.  See display.js for more. */
    o.opaque = ! o.has_alpha || o.surface.format == Constants.SPICE_SURFACE_FMT_32_xRGB;

    /* The cache is filled now, not when the op runs, so a draw from the
       cache that follows this message finds the image whether or not
       either has been drawn yet. */
    if (o.image_data && o.descriptor && (o.descriptor.flags & Constants.SPICE_IMAGE_FLAGS_CACHE_ME))
    {
        if (o.opaque && o.has_alpha)
            stripAlpha(o.image_data);
        if (! ("cache" in this))
            this.cache = {};
        this.cache[o.descriptor.id] = o.image_data;
    }

    this.enqueue(function()
    {
        this.draw_copy_now(o);
    });
    return true;
}

SpiceDisplayConn.prototype.draw_copy_now = function(o)
{
    if (! this.surface_live(o.surface))
        return;
    var image_data = o.image_data || (o.resolve ? o.resolve() : undefined);
    if (! image_data)
        return;

    var canvas = o.surface.canvas;
    var left = o.base.box.left;
    var top = o.base.box.top;
    var width = o.base.box.right - left;
    var height = o.base.box.bottom - top;
    var src = source_rect(o, image_data.width, image_data.height);
    var scaled = (src.right - src.left) != width || (src.bottom - src.top) != height;
    if (o.opaque && o.has_alpha)
        stripAlpha(image_data);

    /* A rop other than copy, or a mask, means combining with what is
       there, pixel by pixel. */
    if ((o.rop !== undefined && o.rop != ROP.COPY) || o.mask)
    {
        /* On a surface whose alpha is part of the image, the alpha byte
           is combined like the colour; an opaque draw leaves it. */
        var copy_tables = rop_tables(o.rop === undefined ? ROP.COPY : o.rop);
        combine_rects(canvas.context, o.base.box, clipped_rects(o.base.box, o.base.clip),
                      source_for_box(image_data, src, o.base.box), o.mask,
                      o.opaque ? copy_tables : with_alpha(copy_tables));
        o.surface.draw_count++;
        return;
    }

    /* src_area picks the part of the image that lands in the box, and a
       box of another size scales it. putImageData can offset but not
       scale, so a scaled draw goes through drawImage, which needs the
       alpha bytes made opaque above to copy rather than blend. */
    /* An alpha surface takes the image as it is, alpha included; drawing
       it through drawImage would blend over what is there. */
    var replace = o.opaque || o.surface.format == Constants.SPICE_SURFACE_FMT_8_A;

    if (scaled)
    {
        canvas.context.imageSmoothingEnabled = o.scale_mode != Constants.SPICE_IMAGE_SCALE_MODE_NEAREST;
        with_clip(canvas.context, o.base.clip, function()
        {
            putImageDataWithAlpha(canvas.context, image_data, left, top, src, width, height);
        });
        canvas.context.imageSmoothingEnabled = true;
    }
    else if (is_clipped(o.base.clip))
    {
        if (replace)
            putImageDataClipped(canvas.context, image_data, left, top, o.base.clip, src);
        else
            with_clip(canvas.context, o.base.clip, function()
            {
                putImageDataWithAlpha(canvas.context, image_data, left, top, src, width, height);
            });
    }
    else if (replace)
        canvas.context.putImageData(image_data, left - src.left, top - src.top, src.left, src.top, width, height);
    else
        putImageDataWithAlpha(canvas.context, image_data, left, top, src, width, height);

    if (Utils.DUMP_DRAWS && this.parent.dump_id)
    {
        var debug_canvas = document.createElement("canvas");
        debug_canvas.setAttribute('width', image_data.width);
        debug_canvas.setAttribute('height', image_data.height);
        debug_canvas.setAttribute('id', o.tag + "." +
            o.surface.draw_count + "." +
            o.base.surface_id + "@" + o.base.box.left + "x" +  o.base.box.top);
        debug_canvas.getContext("2d").putImageData(image_data, 0, 0);
        document.getElementById(this.parent.dump_id).appendChild(debug_canvas);
    }

    o.surface.draw_count++;
}


SpiceDisplayConn.prototype.log_draw = function(prefix, draw)
{
    var str = prefix + "." + draw.base.surface_id + "." + this.surfaces[draw.base.surface_id].draw_count + ": ";
    str += "base.box " + draw.base.box.left + ", " + draw.base.box.top + " to " +
                           draw.base.box.right + ", " + draw.base.box.bottom;
    str += "; clip.type " + draw.base.clip.type;

    if (draw.data)
    {
        if (draw.data.src_area)
            str += "; src_area " + draw.data.src_area.left + ", " + draw.data.src_area.top + " to "
                                 + draw.data.src_area.right + ", " + draw.data.src_area.bottom;

        if (draw.data.src_bitmap && draw.data.src_bitmap != null)
        {
            str += "; src_bitmap id: " + draw.data.src_bitmap.descriptor.id;
            str += "; src_bitmap width " + draw.data.src_bitmap.descriptor.width + ", height " + draw.data.src_bitmap.descriptor.height;
            str += "; src_bitmap type " + draw.data.src_bitmap.descriptor.type + ", flags " + draw.data.src_bitmap.descriptor.flags;
            if (draw.data.src_bitmap.surface_id !== undefined)
                str += "; src_bitmap surface_id " + draw.data.src_bitmap.surface_id;
            if (draw.data.src_bitmap.bitmap)
                str += "; BITMAP format " + draw.data.src_bitmap.bitmap.format +
                        "; flags " + draw.data.src_bitmap.bitmap.flags +
                        "; x " + draw.data.src_bitmap.bitmap.x +
                        "; y " + draw.data.src_bitmap.bitmap.y +
                        "; stride " + draw.data.src_bitmap.bitmap.stride ;
            if (draw.data.src_bitmap.quic)
                str += "; QUIC type " + draw.data.src_bitmap.quic.type +
                        "; width " + draw.data.src_bitmap.quic.width +
                        "; height " + draw.data.src_bitmap.quic.height ;
            if (draw.data.src_bitmap.lz_rgb)
                str += "; LZ_RGB length " + draw.data.src_bitmap.lz_rgb.length +
                       "; magic " + draw.data.src_bitmap.lz_rgb.magic +
                       "; version 0x" + draw.data.src_bitmap.lz_rgb.version.toString(16) +
                       "; type " + draw.data.src_bitmap.lz_rgb.type +
                       "; width " + draw.data.src_bitmap.lz_rgb.width +
                       "; height " + draw.data.src_bitmap.lz_rgb.height +
                       "; stride " + draw.data.src_bitmap.lz_rgb.stride +
                       "; top down " + draw.data.src_bitmap.lz_rgb.top_down;
        }
        else
            str += "; src_bitmap is null";

        if (draw.data.brush)
        {
            if (draw.data.brush.type == Constants.SPICE_BRUSH_TYPE_SOLID)
                str += "; brush.color 0x" + draw.data.brush.color.toString(16);
            if (draw.data.brush.type == Constants.SPICE_BRUSH_TYPE_PATTERN)
            {
                str += "; brush.pat ";
                if (draw.data.brush.pattern.pat != null)
                    str += "[SpiceImage]";
                else
                    str += "[null]";
                str += " at " + draw.data.brush.pattern.pos.x + ", " + draw.data.brush.pattern.pos.y;
            }
        }

        str += "; rop_descriptor " + draw.data.rop_descriptor;
        if (draw.data.scale_mode !== undefined)
            str += "; scale_mode " + draw.data.scale_mode;
        str += "; mask.flags " + draw.data.mask.flags;
        str += "; mask.pos " + draw.data.mask.pos.x + ", " + draw.data.mask.pos.y;
        if (draw.data.mask.bitmap != null)
        {
            str += "; mask.bitmap width " + draw.data.mask.bitmap.descriptor.width + ", height " + draw.data.mask.bitmap.descriptor.height;
            str += "; mask.bitmap type " + draw.data.mask.bitmap.descriptor.type + ", flags " + draw.data.mask.bitmap.descriptor.flags;
        }
        else
            str += "; mask.bitmap is null";
    }

    console.log(str);
}

SpiceDisplayConn.prototype.hook_events = function()
{
    if (this.primary_surface !== undefined)
    {
        var canvas = this.surfaces[this.primary_surface].canvas;
        canvas.sc = this.parent;
        canvas.addEventListener('mousemove', Inputs.handle_mousemove);
        canvas.addEventListener('mousedown', Inputs.handle_mousedown);
        canvas.addEventListener('contextmenu', Inputs.handle_contextmenu);
        canvas.addEventListener('mouseup', Inputs.handle_mouseup);
        canvas.addEventListener('keydown', Inputs.handle_keydown);
        canvas.addEventListener('keyup', Inputs.handle_keyup);
        canvas.addEventListener('mouseout', handle_mouseout);
        canvas.addEventListener('mouseover', handle_mouseover);
        canvas.addEventListener('wheel', Inputs.handle_mousewheel);
        canvas.focus();

        this.focusListener = () => this.parent.send_clipboard_grab()
        // send host clipboard when the canvas is rendered initially
        this.focusListener();
        // register focus event to grab host clipboard when the canvas gets focus
        canvas.addEventListener('focus', this.focusListener);
    }
}

SpiceDisplayConn.prototype.unhook_events = function()
{
    if (this.primary_surface !== undefined)
    {
        var canvas = this.surfaces[this.primary_surface].canvas;
        canvas.removeEventListener('mousemove', Inputs.handle_mousemove);
        canvas.removeEventListener('mousedown', Inputs.handle_mousedown);
        canvas.removeEventListener('contextmenu', Inputs.handle_contextmenu);
        canvas.removeEventListener('mouseup', Inputs.handle_mouseup);
        canvas.removeEventListener('keydown', Inputs.handle_keydown);
        canvas.removeEventListener('keyup', Inputs.handle_keyup);
        canvas.removeEventListener('mouseout', handle_mouseout);
        canvas.removeEventListener('mouseover', handle_mouseover);
        canvas.removeEventListener('wheel', Inputs.handle_mousewheel);
        canvas.removeEventListener('focus', this.focusListener);
    }
}


/* MJPEG first, then whatever the decoder probe still says yes to, in the
   order a server would otherwise pick them. Only sent to a server that
   advertised taking the message. */
SpiceDisplayConn.prototype.send_preferred_video_codecs = function()
{
    if (! this.reply_link ||
        ! (this.reply_link.channel_caps[0] & (1 << Constants.SPICE_DISPLAY_CAP_PREF_VIDEO_CODEC_TYPE)))
        return;
    var codecs = [Constants.SPICE_VIDEO_CODEC_TYPE_MJPEG];
    [Constants.SPICE_VIDEO_CODEC_TYPE_H264, Constants.SPICE_VIDEO_CODEC_TYPE_VP9, Constants.SPICE_VIDEO_CODEC_TYPE_VP8].forEach(function(type)
    {
        if (VideoCodecs.supported[type])
            codecs.push(type);
    });
    var msg = new Messages.SpiceMiniData();
    msg.build_msg(Constants.SPICE_MSGC_DISPLAY_PREFERRED_VIDEO_CODEC_TYPE,
                  new Messages.SpiceMsgcDisplayPreferredVideoCodecType(codecs));
    this.send_msg(msg);
}

/* The image compression the application asked for, by enum value or by
   the spice-gtk name ("lz4", "auto_glz", "quic", ...).  Only sent to a
   server that advertised taking the request; the server keeps its own
   default otherwise, and always when nothing was asked for. */
var IMAGE_COMPRESSION_BY_NAME = {
    off: Constants.SPICE_IMAGE_COMPRESSION_OFF,
    auto_glz: Constants.SPICE_IMAGE_COMPRESSION_AUTO_GLZ,
    auto_lz: Constants.SPICE_IMAGE_COMPRESSION_AUTO_LZ,
    quic: Constants.SPICE_IMAGE_COMPRESSION_QUIC,
    glz: Constants.SPICE_IMAGE_COMPRESSION_GLZ,
    lz: Constants.SPICE_IMAGE_COMPRESSION_LZ,
    lz4: Constants.SPICE_IMAGE_COMPRESSION_LZ4,
};

SpiceDisplayConn.prototype.send_preferred_compression = function()
{
    var want = this.parent ? this.parent.preferred_compression : undefined;
    if (want === undefined || want === null)
        return;
    var value = typeof want == "string" ? IMAGE_COMPRESSION_BY_NAME[want.toLowerCase()] : want;
    if (value === undefined || value < Constants.SPICE_IMAGE_COMPRESSION_OFF ||
        value > Constants.SPICE_IMAGE_COMPRESSION_LZ4)
    {
        this.log_warn("Ignoring unknown preferred_compression: " + want);
        return;
    }
    if (! this.reply_link ||
        ! (this.reply_link.channel_caps[0] & (1 << Constants.SPICE_DISPLAY_CAP_PREF_COMPRESSION)))
    {
        this.log_info("Server does not take a preferred compression; keeping its default");
        return;
    }
    var msg = new Messages.SpiceMiniData();
    msg.build_msg(Constants.SPICE_MSGC_DISPLAY_PREFERRED_COMPRESSION,
                  new Messages.SpiceMsgcDisplayPreferredCompression(value));
    this.send_msg(msg);
}

SpiceDisplayConn.prototype.destroy_stream = function(id)
{
    var stream = this.streams[id];
    if (stream.decoder)
        close_stream_decoder(this, stream);
    else if (stream.codec_type == Constants.SPICE_VIDEO_CODEC_TYPE_VP8)
    {
        if (stream.video)
        {
            if (stream.video.parentNode)
                stream.video.parentNode.removeChild(stream.video);
            /* The blob URL registration outlives the element; without the
               revoke each stream create/destroy cycle leaked one. */
            window.URL.revokeObjectURL(stream.video.src);
        }
        stream.source_buffer = null;
        stream.media = null;
        stream.video = null;
    }
    this.streams[id] = undefined;
}

SpiceDisplayConn.prototype.destroy_surfaces = function()
{
    this.drop_queue();
    for (var s in this.surfaces)
    {
        this.delete_surface(this.surfaces[s].surface_id);
    }

    this.surfaces = undefined;

    /* Streams own DOM video elements and MediaSources that live in the
       screen div, not in a surface; a client-side stop mid-stream left
       them behind to pile up across reconnects. */
    if (this.streams)
    {
        for (var i = 0; i < this.streams.length; i++)
        {
            if (this.streams[i])
                this.destroy_stream(i);
        }
        this.streams = undefined;
    }
}


function handle_mouseover(e)
{
    this.focus();
}

function handle_mouseout(e)
{
    if (this.sc && this.sc.cursor && this.sc.cursor.spice_simulated_cursor)
        this.sc.cursor.spice_simulated_cursor.style.display = 'none';
    this.blur();
}

function handle_draw_jpeg_onload()
{
    /* The decoded bitmap survives the revoke; without it every frame's
       blob stays registered for the life of the page. */
    revoke_jpeg_image_url(this);

    if (this.o.sc.streams && this.o.sc.streams[this.o.id])
        this.o.sc.streams[this.o.id].frames_loading--;

    var img = this;
    this.o.sc.mark_ready(this.o.op, function() { draw_jpeg_now(img); });
}

/* The decoded JPEG under its LZ alpha plane, on a canvas its own size. */
function jpeg_alpha_canvas(img)
{
    var c = document.createElement("canvas");
    var t = c.getContext("2d");
    c.setAttribute('width', img.alpha_img.width);
    c.setAttribute('height', img.alpha_img.height);
    t.putImageData(img.alpha_img, 0, 0);
    t.globalCompositeOperation = 'source-in';
    t.drawImage(img, 0, 0);
    return c;
}

/* Runs from the draw queue once every op queued before the JPEG has run. */
function draw_jpeg_now(img)
{
    var sc = img.o.sc;
    var o = img.o;

    /*------------------------------------------------------------
    ** FIXME:
    **  The helper should be extended to be able to handle actual HtmlImageElements
    **  ...and the cache should be modified to do so as well
    **----------------------------------------------------------*/
    if (! sc.surface_live(o.surface))
    {
        // The surface was destroyed (e.g. open a menu, close it quickly)
        //  or the connection stopped while the image was decoding.
        Utils.DEBUG > 2 && sc.log_info("Discarding jpeg; presumed lost surface " + o.base.surface_id);
        img.onload = undefined;
        img.src = Utils.EMPTY_GIF_IMAGE;
        return;
    }
    var context = o.surface.canvas.context;
    var left = o.base.box.left;
    var top = o.base.box.top;
    var width = o.base.box.right - left;
    var height = o.base.box.bottom - top;
    var src = source_rect(o, img.width, img.height);
    var sw = src.right - src.left;
    var sh = src.bottom - src.top;
    context.imageSmoothingEnabled = o.scale_mode != Constants.SPICE_IMAGE_SCALE_MODE_NEAREST;

    /* A rop other than copy, or a mask, combines the image with what is
       there pixel by pixel, which draw_copy_now does from an ImageData. */
    if ((o.rop !== undefined && o.rop != ROP.COPY) || o.mask)
    {
        o.image_data = img.alpha_img ?
            jpeg_alpha_canvas(img).getContext("2d").getImageData(0, 0, img.alpha_img.width, img.alpha_img.height) :
            image_to_image_data(img, img.width, img.height);
        o.has_alpha = !! img.alpha_img;
        o.opaque = ! o.has_alpha || o.surface.format == Constants.SPICE_SURFACE_FMT_32_xRGB;
        if (o.descriptor && (o.descriptor.flags & Constants.SPICE_IMAGE_FLAGS_CACHE_ME))
        {
            if (! ("cache" in sc))
                sc.cache = {};
            sc.cache[o.descriptor.id] = o.image_data;
        }
        sc.draw_copy_now(o);
        context.imageSmoothingEnabled = true;
        img.onload = undefined;
        img.src = Utils.EMPTY_GIF_IMAGE;
        return;
    }

    if (img.alpha_img)
    {
        var c = jpeg_alpha_canvas(img);
        var t = c.getContext("2d");

        with_clip(context, o.base.clip, function()
        {
            context.drawImage(c, src.left, src.top, sw, sh, left, top, width, height);
        });

        if (o.descriptor &&
            (o.descriptor.flags & Constants.SPICE_IMAGE_FLAGS_CACHE_ME))
        {
            if (! ("cache" in sc))
                sc.cache = {};

            sc.cache[o.descriptor.id] =
                t.getImageData(0, 0,
                    img.alpha_img.width,
                    img.alpha_img.height);
        }
    }
    else
    {
        with_clip(context, o.base.clip, function()
        {
            if (o.bottom_up)
            {
                /* The encoder emits a bottom-up frame's rows in memory
                   order, last row first; flip it back while blitting. */
                context.save();
                context.translate(left, top + height);
                context.scale(1, -1);
                context.drawImage(img, src.left, src.top, sw, sh, 0, 0, width, height);
                context.restore();
            }
            else
                context.drawImage(img, src.left, src.top, sw, sh, left, top, width, height);
        });

        if (o.descriptor &&
            (o.descriptor.flags & Constants.SPICE_IMAGE_FLAGS_CACHE_ME))
        {
            if (! ("cache" in sc))
                sc.cache = {};

            /* The cache wants the whole image; a clipped, offset or scaled
               draw left only part of it, or a resampling, on the surface. */
            var whole = src.left == 0 && src.top == 0 && sw == img.width && sh == img.height &&
                        width == img.width && height == img.height;
            sc.cache[o.descriptor.id] = (is_clipped(o.base.clip) || ! whole) ?
                image_to_image_data(img, img.width, img.height) :
                context.getImageData(left, top, width, height);
        }

        // Give the Garbage collector a clue to recycle this; avoids
        //  fairly massive memory leaks during video playback
        img.onload = undefined;
        img.src = Utils.EMPTY_GIF_IMAGE;
    }

    context.imageSmoothingEnabled = true;

    if (Utils.DUMP_DRAWS && sc.parent.dump_id)
    {
        var debug_canvas = document.createElement("canvas");
        debug_canvas.setAttribute('id', o.tag + "." +
            o.surface.draw_count + "." +
            o.base.surface_id + "@" + o.base.box.left + "x" +  o.base.box.top);
        debug_canvas.getContext("2d").drawImage(img, 0, 0);
        document.getElementById(sc.parent.dump_id).appendChild(debug_canvas);
    }

    o.surface.draw_count++;

    if (sc.streams && sc.streams[o.id] && "report" in sc.streams[o.id])
        process_stream_data_report(sc, o.id, o.msg_mmtime, o.msg_mmtime - sc.parent.relative_now());
}

/*----------------------------------------------------------------------------
**  Streams through a WebCodecs VideoDecoder
**      Each STREAM_DATA is one EncodedVideoChunk; the decoded frame is
**      drawn into the surface through the draw queue, in order with
**      everything else, under the stream's clip, so a decoded stream
**      composes like any other draw and needs no element floated over
**      the canvas. SPICE does not flag key frames, so the bitstream is
**      read for one: nothing is decoded before the first, and a backlog
**      is cleared by dropping until the next, since an inter frame
**      cannot be dropped on its own.
**--------------------------------------------------------------------------*/
var DECODER_BACKLOG_LIMIT = 8;

function create_stream_decoder(sc, stream, codec)
{
    stream.pending_frames = [];
    stream.awaiting_key = true;
    stream.decoder_failed = false;
    stream.decoder = new VideoDecoder(
    {
        output: function(frame) { handle_decoded_frame(sc, stream, frame); },
        error: function(e)
        {
            sc.log_err("Video decoder for stream " + stream.id + " failed: " + e.message);
            abandon_stream_codec(sc, stream);
        },
    });
    try
    {
        stream.decoder.configure(
        {
            codec: codec,
            codedWidth: stream.stream_width,
            codedHeight: stream.stream_height,
            optimizeForLatency: true,
        });
    }
    catch (e)
    {
        sc.log_err("Video decoder for stream " + stream.id + " refused " + codec + ": " + e.message);
        abandon_stream_codec(sc, stream);
    }
}

/* Frames still waiting on the decoder are released so the draw queue can
   move on; the stream stays registered, and drops its data, until the
   server destroys it. */
function fail_stream_decoder(sc, stream)
{
    stream.decoder_failed = true;
    var pending = stream.pending_frames;
    stream.pending_frames = [];
    for (var i = 0; i < pending.length; i++)
    {
        pending[i].op.on_stale = undefined;
        sc.mark_ready(pending[i].op, null);
    }
}

/* A codec the decoder could not take is struck off for this session and
   the server is asked to prefer MJPEG over it; a server that honours the
   request tears the stream down and recreates it with the new codec, so
   the stream recovers instead of staying dark. */
function abandon_stream_codec(sc, stream)
{
    fail_stream_decoder(sc, stream);
    if (! VideoCodecs.supported[stream.codec_type])
        return;
    VideoCodecs.supported[stream.codec_type] = false;
    sc.send_preferred_video_codecs();
}

function close_stream_decoder(sc, stream)
{
    fail_stream_decoder(sc, stream);
    try
    {
        if (stream.decoder.state != "closed")
            stream.decoder.close();
    }
    catch (e)
    {
    }
    stream.decoder = null;
}

function process_decoder_stream_data(sc, stream, m, time_until_due)
{
    if (stream.decoder_failed)
        return;
    var data = m.data instanceof Uint8Array ? m.data : new Uint8Array(m.data);
    var key = video_keyframe(stream.codec_type, data);

    if (stream.awaiting_key)
    {
        if (! key)
        {
            if ("report" in stream)
                stream.report.num_drops++;
            return;
        }
        stream.awaiting_key = false;
    }
    else if (! key && time_until_due < 0 && stream.decoder.decodeQueueSize > DECODER_BACKLOG_LIMIT)
    {
        /* Late and backed up: drop this frame and every one until the
           next key frame, the only place the stream can resume. */
        stream.awaiting_key = true;
        if ("report" in stream)
            stream.report.num_drops++;
        return;
    }

    var op = sc.enqueue_pending();
    /* A decoder that takes a frame and never outputs one, rather than
       erroring, is found out by the draw queue's stale check. */
    op.on_stale = function() { abandon_stream_codec(sc, stream); };
    stream.pending_frames.push(
    {
        op: op,
        msg_mmtime: m.base.multi_media_time,
        dest: m.dest || stream.dest,
        clip: stream.clip,
    });
    try
    {
        stream.decoder.decode(new EncodedVideoChunk(
        {
            type: key ? "key" : "delta",
            timestamp: m.base.multi_media_time * 1000,
            data: data,
        }));
    }
    catch (e)
    {
        sc.log_err("Video decoder for stream " + stream.id + " rejected a frame: " + e.message);
        abandon_stream_codec(sc, stream);
    }
}

function handle_decoded_frame(sc, stream, frame)
{
    var item = stream.pending_frames.shift();
    if (! item)
    {
        frame.close();
        return;
    }
    item.op.release = function() { frame.close(); };
    sc.mark_ready(item.op, function()
    {
        item.op.release = undefined;
        draw_decoded_frame(this, stream, frame, item);
    });
}

function draw_decoded_frame(sc, stream, frame, item)
{
    var surface = sc.surfaces ? sc.surfaces[stream.surface_id] : undefined;
    if (surface === undefined || ! sc.streams || sc.streams[stream.id] !== stream)
    {
        frame.close();
        return;
    }
    var context = surface.canvas.context;
    var dest = item.dest;
    var width = dest.right - dest.left;
    var height = dest.bottom - dest.top;
    with_clip(context, item.clip, function()
    {
        if (! (stream.flags & Constants.SPICE_STREAM_FLAGS_TOP_DOWN))
        {
            /* Bottom-up frames arrive last row first; flip while blitting. */
            context.save();
            context.translate(dest.left, dest.top + height);
            context.scale(1, -1);
            context.drawImage(frame, 0, 0, width, height);
            context.restore();
        }
        else
            context.drawImage(frame, dest.left, dest.top, width, height);
    });
    frame.close();
    surface.draw_count++;

    if ("report" in stream)
        process_stream_data_report(sc, stream.id, item.msg_mmtime, item.msg_mmtime - sc.parent.relative_now());
}

function process_mjpeg_stream_data(sc, m, time_until_due)
{
    /* If we are currently processing an mjpeg frame when a new one arrives,
       and the new one is 'late', drop the new frame.  This helps the browsers
       keep up, and provides rate control feedback as well */
    if (time_until_due < 0 && sc.streams[m.base.id].frames_loading > 0)
    {
        if ("report" in sc.streams[m.base.id])
            sc.streams[m.base.id].report.num_drops++;
        return;
    }

    var img = new Image;
    var strm_base = new Messages.SpiceMsgDisplayBase();
    strm_base.surface_id = sc.streams[m.base.id].surface_id;
    strm_base.box = m.dest || sc.streams[m.base.id].dest;
    strm_base.clip = sc.streams[m.base.id].clip;
    img.o =
        { base: strm_base,
          tag: "mjpeg." + m.base.id,
          descriptor: null,
          sc : sc,
          id : m.base.id,
          msg_mmtime : m.base.multi_media_time,
          bottom_up : ! (sc.streams[m.base.id].flags & Constants.SPICE_STREAM_FLAGS_TOP_DOWN),
          surface : sc.surfaces ? sc.surfaces[strm_base.surface_id] : undefined,
          op : sc.enqueue_pending(),
        };
    img.onload = handle_draw_jpeg_onload;
    img.onerror = handle_draw_jpeg_onerror;
    img.src = jpeg_image_url(m.data);

    sc.streams[m.base.id].frames_loading++;
}

function process_stream_data_report(sc, id, msg_mmtime, time_until_due)
{
    sc.streams[id].report.num_frames++;
    if (sc.streams[id].report.start_frame_mm_time == 0)
        sc.streams[id].report.start_frame_mm_time = msg_mmtime;

    if (sc.streams[id].report.num_frames > sc.streams[id].max_window_size ||
        (msg_mmtime - sc.streams[id].report.start_frame_mm_time) > sc.streams[id].timeout_ms)
    {
        sc.streams[id].report.end_frame_mm_time = msg_mmtime;
        sc.streams[id].report.last_frame_delay = time_until_due;

        var msg = new Messages.SpiceMiniData();
        msg.build_msg(Constants.SPICE_MSGC_DISPLAY_STREAM_REPORT, sc.streams[id].report);
        sc.send_msg(msg);

        sc.streams[id].report.start_frame_mm_time = 0;
        sc.streams[id].report.num_frames = 0;
        sc.streams[id].report.num_drops = 0;
    }
}

function handle_video_source_open(e)
{
    var stream = this.stream;
    var p = this.spiceconn;

    if (stream.source_buffer)
        return;

    var s = this.addSourceBuffer(Webm.Constants.SPICE_VP8_CODEC);
    if (! s)
    {
        p.log_err('Codec ' + Webm.Constants.SPICE_VP8_CODEC + ' not available.');
        return;
    }

    stream.source_buffer = s;
    s.spiceconn = p;
    s.stream = stream;

    listen_for_video_events(stream);

    var h = new Webm.Header();
    var te = new Webm.VideoTrackEntry(this.stream.stream_width, this.stream.stream_height);
    var t = new Webm.Tracks(te);

    var mb = new ArrayBuffer(h.buffer_size() + t.buffer_size())

    var b = h.to_buffer(mb);
    t.to_buffer(mb, b);

    s.addEventListener('error', handle_video_buffer_error, false);
    s.addEventListener('updateend', handle_append_video_buffer_done, false);

    append_video_buffer(s, mb);
}

function handle_video_source_ended(e)
{
    var p = this.spiceconn;
    p.log_err('Video source unexpectedly ended.');
}

function handle_video_source_closed(e)
{
    var p = this.spiceconn;
    p.log_err('Video source unexpectedly closed.');
}

function append_video_buffer(sb, mb)
{
    try
    {
        sb.stream.append_okay = false;
        sb.appendBuffer(mb);
    }
    catch (e)
    {
        var p = sb.spiceconn;
        p.log_err("Error invoking appendBuffer: " + e.message);
    }
}

function handle_append_video_buffer_done(e)
{
    var stream = this.stream;

    if (stream.current_frame && "report" in stream)
    {
        var sc = this.stream.media.spiceconn;
        var t = this.stream.current_frame.msg_mmtime;
        process_stream_data_report(sc, stream.id, t, t - sc.parent.relative_now());
    }

    if (stream.queue.length > 0)
    {
        stream.current_frame = stream.queue.shift();
        append_video_buffer(stream.source_buffer, stream.current_frame.mb);
    }
    else
    {
        stream.append_okay = true;
    }

    if (!stream.video)
    {
        if (Utils.STREAM_DEBUG > 0)
            console.log("Stream id " + stream.id + " received updateend after video is gone.");
        return;
    }

    if (stream.video.buffered.length > 0 &&
        stream.video.currentTime < stream.video.buffered.start(stream.video.buffered.length - 1))
    {
        console.log("Video appears to have fallen behind; advancing to " +
            stream.video.buffered.start(stream.video.buffered.length - 1));
        stream.video.currentTime = stream.video.buffered.start(stream.video.buffered.length - 1);
    }

    /* Modern browsers try not to auto play video. */
    if (this.stream.video.paused && this.stream.video.readyState >= 2)
        var promise = this.stream.video.play();

    if (Utils.STREAM_DEBUG > 1)
        console.log(stream.video.currentTime + ":id " +  stream.id + " updateend " + Utils.dump_media_element(stream.video));
}

function handle_video_buffer_error(e)
{
    var p = this.spiceconn;
    p.log_err('source_buffer error ' + e.message);
}

function push_or_queue(stream, msg, mb)
{
    var frame =
    {
        msg_mmtime : msg.base.multi_media_time,
    };

    if (stream.append_okay)
    {
        stream.current_frame = frame;
        append_video_buffer(stream.source_buffer, mb);
    }
    else
    {
        frame.mb = mb;
        stream.queue.push(frame);
    }
}

function video_simple_block(stream, msg, keyframe)
{
    var simple = new Webm.SimpleBlock(msg.base.multi_media_time - stream.cluster_time, msg.data, keyframe);
    var mb = new ArrayBuffer(simple.buffer_size());
    simple.to_buffer(mb);

    push_or_queue(stream, msg, mb);
}

function new_video_cluster(stream, msg)
{
    stream.cluster_time = msg.base.multi_media_time;
    var c = new Webm.Cluster(stream.cluster_time - stream.start_time, msg.data);

    var mb = new ArrayBuffer(c.buffer_size());
    c.to_buffer(mb);

    push_or_queue(stream, msg, mb);

    video_simple_block(stream, msg, true);
}

function process_video_stream_data(stream, msg)
{
    if (stream.start_time == 0)
    {
        stream.start_time = msg.base.multi_media_time;
        new_video_cluster(stream, msg);
    }

    else if (msg.base.multi_media_time - stream.cluster_time >= Webm.Constants.MAX_CLUSTER_TIME)
        new_video_cluster(stream, msg);
    else
        video_simple_block(stream, msg, false);
}

function video_handle_event_debug(e)
{
    var s = this.spice_stream;
    if (s.video)
    {
        if (Utils.STREAM_DEBUG > 0 || s.video.buffered.len > 1)
            console.log(s.video.currentTime + ":id " +  s.id + " event " + e.type +
                Utils.dump_media_element(s.video));
    }

    if (Utils.STREAM_DEBUG > 1 && s.media)
        console.log("  media_source " + Utils.dump_media_source(s.media));

    if (Utils.STREAM_DEBUG > 1 && s.source_buffer)
        console.log("  source_buffer " + Utils.dump_source_buffer(s.source_buffer));

    if (Utils.STREAM_DEBUG > 1 || s.queue.length > 1)
        console.log('  queue len ' + s.queue.length + '; append_okay: ' + s.append_okay);
}

function video_debug_listen_for_one_event(name)
{
    this.addEventListener(name, video_handle_event_debug);
}

function listen_for_video_events(stream)
{
    var video_0_events = [
        "abort", "error"
    ];

    var video_1_events = [
        "loadstart", "suspend", "emptied", "stalled", "loadedmetadata", "loadeddata", "canplay",
        "canplaythrough", "playing", "waiting", "seeking", "seeked", "ended", "durationchange",
        "play", "pause", "ratechange"
    ];

    var video_2_events = [
        "timeupdate",
        "progress",
        "resize",
        "volumechange"
    ];

    video_0_events.forEach(video_debug_listen_for_one_event, stream.video);
    if (Utils.STREAM_DEBUG > 0)
        video_1_events.forEach(video_debug_listen_for_one_event, stream.video);
    if (Utils.STREAM_DEBUG > 1)
        video_2_events.forEach(video_debug_listen_for_one_event, stream.video);
}

export {
  SpiceDisplayConn,
};
