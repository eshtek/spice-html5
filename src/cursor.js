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

import { create_rgba_png } from './png.js';
import { Constants } from './enums.js';
import { DEBUG } from './utils.js';
import {
  SpiceMsgCursorInit,
  SpiceMsgCursorMove,
  SpiceMsgCursorInvalOne,
  SpiceMsgCursorSet,
} from './spicemsg.js';
import { SpiceSimulateCursor } from './simulatecursor.js';
import { SpiceConn } from './spiceconn.js';

/*----------------------------------------------------------------------------
**  SpiceCursorConn
**      Drive the Spice Cursor Channel
**--------------------------------------------------------------------------*/
function SpiceCursorConn()
{
    SpiceConn.apply(this, arguments);
}

SpiceCursorConn.prototype = Object.create(SpiceConn.prototype);
SpiceCursorConn.prototype.process_channel_message = function(msg)
{
    if (msg.type == Constants.SPICE_MSG_CURSOR_INIT)
    {
        var cursor_init = new SpiceMsgCursorInit(msg.data);
        DEBUG > 1 && console.log("SpiceMsgCursorInit");
        if (this.parent && this.parent.inputs &&
            this.parent.inputs.mouse_mode == Constants.SPICE_MOUSE_MODE_SERVER)
        {
            // FIXME - this imagines that the server actually
            //          provides the current cursor position,
            //          instead of 0,0.  As of May 11, 2012,
            //          that assumption was false :-(.
            this.parent.inputs.mousex = cursor_init.position.x;
            this.parent.inputs.mousey = cursor_init.position.y;
        }
        /* INIT with no shape leaves the pointer as it is; only a SET
           of none hides it. */
        if (cursor_init.cursor && ! (cursor_init.cursor.flags & Constants.SPICE_CURSOR_FLAGS_NONE))
            this.handle_cursor(cursor_init.cursor, cursor_init.visible);
        return true;
    }

    if (msg.type == Constants.SPICE_MSG_CURSOR_SET)
    {
        var cursor_set = new SpiceMsgCursorSet(msg.data);
        DEBUG > 1 && console.log("SpiceMsgCursorSet");
        this.handle_cursor(cursor_set.cursor, cursor_set.visible);
        return true;
    }

    if (msg.type == Constants.SPICE_MSG_CURSOR_MOVE)
    {
        /* Only meaningful under server mouse mode, where the server owns
           the pointer position and we track it for inputs. Under client
           mode the browser draws the pointer and already knows where it
           is, so there is nothing to do -- but it is handled either way,
           rather than reported as unimplemented on every move. */
        var cursor_move = new SpiceMsgCursorMove(msg.data);
        if (this.parent && this.parent.inputs &&
            this.parent.inputs.mouse_mode == Constants.SPICE_MOUSE_MODE_SERVER)
        {
            this.parent.inputs.mousex = cursor_move.position.x;
            this.parent.inputs.mousey = cursor_move.position.y;
        }
        return true;
    }

    if (msg.type == Constants.SPICE_MSG_CURSOR_HIDE)
    {
        DEBUG > 1 && console.log("SpiceMsgCursorHide");
        this.hide_cursor();
        return true;
    }

    if (msg.type == Constants.SPICE_MSG_CURSOR_TRAIL)
    {
        this.known_unimplemented(msg.type, "Cursor Trail");
        return true;
    }

    if (msg.type == Constants.SPICE_MSG_CURSOR_RESET)
    {
        DEBUG > 1 && console.log("SpiceMsgCursorReset");
        document.getElementById(this.parent.screen_id).style.cursor = "auto";
        return true;
    }

    if (msg.type == Constants.SPICE_MSG_CURSOR_INVAL_ONE)
    {
        var inval = new SpiceMsgCursorInvalOne(msg.data);
        if (this.cursor_cache)
            delete this.cursor_cache[String(inval.id)];
        return true;
    }

    if (msg.type == Constants.SPICE_MSG_CURSOR_INVAL_ALL)
    {
        DEBUG > 1 && console.log("SpiceMsgCursorInvalAll");
        this.cursor_cache = undefined;
        return true;
    }

    return false;
}

/* One warning per shape type per connection. Windows sends a cursor on
   nearly every hover, so an unconvertible type used to produce an
   unbounded stream of identical warnings. */
SpiceCursorConn.prototype.warn_once_per_cursor_type = function(type)
{
    if (! this.warned_cursor_types)
        this.warned_cursor_types = {};
    if (this.warned_cursor_types[type])
        return;
    this.warned_cursor_types[type] = true;
    this.log_warn("No support for cursor type " + type + "; leaving the cursor as it was.");
}

/* SPICE cursor shapes to the RGBA the PNG writer expects.
   Returns null for a type we cannot convert.
   Layouts follow spice-gtk's set_cursor() (src/channel-cursor.c). */
function cursor_to_rgba(header, data)
{
    var width = header.width;
    var height = header.height;
    var pixels = width * height;
    var u8 = new Uint8Array(data);
    var rgba = new Uint8Array(pixels * 4);
    var i, at;

    /* SPICE ships 32bpp shapes as native-endian ARGB, which on every
       platform we run on is B,G,R,A in memory; PNG wants R,G,B,A. The
       swap is invisible on the black/white/transparent cursors that
       dominate, which is why it went unnoticed, but colour cursors came
       out with red and blue exchanged. */
    if (header.type == Constants.SPICE_CURSOR_TYPE_ALPHA)
    {
        if (u8.length < pixels * 4)
            return null;
        for (i = 0, at = 0; i < pixels; i++, at += 4)
        {
            rgba[at]     = u8[at + 2];
            rgba[at + 1] = u8[at + 1];
            rgba[at + 2] = u8[at];
            rgba[at + 3] = u8[at + 3];
        }
        return rgba;
    }

    /* Two 1bpp masks, AND then XOR, each row padded to a byte. The four
       combinations are the classic ones:
         AND=1 XOR=0  transparent
         AND=1 XOR=1  invert the screen
         AND=0 XOR=0  black
         AND=0 XOR=1  white
       A CSS cursor cannot invert what is under it, so those pixels are
       drawn black -- the same choice every other HTML SPICE/VNC client
       makes. It is what Windows' I-beam and resize cursors use, and
       black-on-transparent reads correctly against the light backgrounds
       those appear over. */
    if (header.type == Constants.SPICE_CURSOR_TYPE_MONO)
    {
        var bpl = (width + 7) >> 3;
        if (u8.length < bpl * height * 2)
            return null;
        for (var y = 0; y < height; y++)
        {
            for (var x = 0; x < width; x++)
            {
                var byte_at = y * bpl + (x >> 3);
                var bit = 0x80 >> (x & 7);
                var and_bit = (u8[byte_at] & bit) != 0;
                var xor_bit = (u8[bpl * height + byte_at] & bit) != 0;

                at = (y * width + x) * 4;
                if (and_bit && ! xor_bit)
                    continue;               /* transparent; rgba is zeroed */

                var lum = xor_bit && ! and_bit ? 255 : 0;
                rgba[at] = rgba[at + 1] = rgba[at + 2] = lum;
                rgba[at + 3] = 255;
            }
        }
        return rgba;
    }

    /* 32bpp BGRA followed by a 1bpp AND mask: mask set means the pixel
       is transparent. spice-gtk renders the "white pixel that is also
       masked" case as a dim checkerboard rather than a hole, because
       that combination is how shapes encode invert; do the same. */
    if (header.type == Constants.SPICE_CURSOR_TYPE_COLOR32)
    {
        var mask_at = pixels * 4;
        if (u8.length < mask_at + ((width + 7) >> 3) * height)
            return null;
        for (i = 0, at = 0; i < pixels; i++, at += 4)
        {
            var masked = (u8[mask_at + (i >> 3)] & (0x80 >> (i & 7))) != 0;
            var white = u8[at] == 0xff && u8[at + 1] == 0xff && u8[at + 2] == 0xff;
            if (masked && white)
            {
                var dark = (((i % width) ^ ((i / width) | 0)) & 1) != 0;
                rgba[at] = rgba[at + 1] = rgba[at + 2] = dark ? 0x30 : 0x50;
                rgba[at + 3] = dark ? 0xc0 : 0x30;
                continue;
            }
            rgba[at]     = u8[at + 2];
            rgba[at + 1] = u8[at + 1];
            rgba[at + 2] = u8[at];
            rgba[at + 3] = masked ? 0 : 255;
        }
        return rgba;
    }

    return null;
}

/* True if the shape was converted and applied. */
/* A cursor from SET or INIT: none hides; from-cache looks the shape up
   by its id; otherwise the shape is converted, remembered when asked
   (Windows sends a shape on nearly every hover and then refers back to
   it), and shown.  An unconvertible shape is not an unhandled message:
   returning false made the base class log a misleading "Unknown message
   type" for every one of these. */
SpiceCursorConn.prototype.handle_cursor = function(cursor, visible)
{
    if (cursor.flags & Constants.SPICE_CURSOR_FLAGS_NONE)
    {
        this.hide_cursor();
        return;
    }
    var shape;
    var id = String(cursor.header.unique);
    if (cursor.flags & Constants.SPICE_CURSOR_FLAGS_FROM_CACHE)
    {
        shape = this.cursor_cache ? this.cursor_cache[id] : undefined;
        if (! shape)
        {
            this.log_warn("FIXME: cursor " + id + " not in cache");
            return;
        }
    }
    else
    {
        shape = convert_cursor(cursor);
        if (! shape)
        {
            this.warn_once_per_cursor_type(cursor.header.type);
            return;
        }
        if (cursor.flags & Constants.SPICE_CURSOR_FLAGS_CACHE_ME)
        {
            if (! this.cursor_cache)
                this.cursor_cache = {};
            this.cursor_cache[id] = shape;
        }
    }
    if (visible === 0)
        this.hide_cursor();
    else
        this.show_cursor(shape);
}

/* The CSS and PNG for a shape, or undefined for a type not converted. */
function convert_cursor(cursor)
{
    var rgba = cursor_to_rgba(cursor.header, cursor.data);
    if (! rgba)
        return undefined;
    var pngstr = create_rgba_png(cursor.header.width, cursor.header.height, rgba);
    var curstr = 'url(data:image/png,' + pngstr + ') ' +
        cursor.header.hot_spot_x + ' ' + cursor.header.hot_spot_y + ", default";
    return { curstr: curstr, pngstr: pngstr, cursor: cursor };
}

SpiceCursorConn.prototype.set_cursor = function(cursor)
{
    var shape = convert_cursor(cursor);
    if (! shape)
        return false;
    this.show_cursor(shape);
    return true;
}

SpiceCursorConn.prototype.show_cursor = function(shape)
{
    var curstr = shape.curstr, pngstr = shape.pngstr, cursor = shape.cursor;
    var screen = document.getElementById(this.parent.screen_id);
    screen.style.cursor = 'auto';
    screen.style.cursor = curstr;
    if (window.getComputedStyle(screen, null).cursor == 'auto')
        SpiceSimulateCursor.simulate_cursor(this, cursor, screen, pngstr);
    else
    {
        /* This cursor took effect natively, so drop the simulated one
           left by an earlier browser-rejected cursor; the mousemove
           handler would otherwise keep painting it alongside the real
           cursor forever. */
        this.remove_simulated_cursor();
    }
}

/* A hidden pointer is hidden whichever way the last shape was shown:
   the CSS cursor goes to none, and a simulated cursor image is removed,
   or the mousemove handler would keep painting it. */
SpiceCursorConn.prototype.hide_cursor = function()
{
    document.getElementById(this.parent.screen_id).style.cursor = "none";
    this.remove_simulated_cursor();
}

SpiceCursorConn.prototype.remove_simulated_cursor = function()
{
    if (! this.spice_simulated_cursor)
        return;
    if (this.spice_simulated_cursor.parentNode)
        this.spice_simulated_cursor.parentNode.removeChild(this.spice_simulated_cursor);
    delete this.spice_simulated_cursor;
}

SpiceCursorConn.prototype.cleanup = function()
{
    /* The screen div outlives the connection: a simulated cursor left in
       it would sit frozen over the next session, and a guest that ended
       with its pointer hidden (or a custom shape) would leave the next
       one without a visible pointer until it sends a shape of its own. */
    this.remove_simulated_cursor();
    var screen = document.getElementById(this.parent.screen_id);
    if (screen)
        screen.style.cursor = "auto";
    SpiceConn.prototype.cleanup.call(this);
}

export {
  SpiceCursorConn,
};
