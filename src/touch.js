"use strict";
/*
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
**  Touch input
**      A touchscreen has no mouse. A browser makes one up for a tap, a
**      press and a release at one point once the finger has lifted, and
**      nothing at all for a finger that moves: no drag, no wheel. So
**      fingers are read here and turned into the mouse a guest expects.
**
**          tap                     left click
**          second tap nearby       lands on the first, as a double click must
**          long press              right click
**          one finger moving       left button held: a drag
**          two fingers moving      wheel, the content following the fingers
**          two fingers spreading   zoom, if the page asked to be told of it
**          two finger tap          right click
**          three finger tap        middle click
**--------------------------------------------------------------------------*/

import { Constants } from './enums.js';
import * as Inputs from './inputs.js';

var TOUCH_DEFAULTS = {
    slop_px: 10,            /* travel under this is still a tap */
    long_press_ms: 500,
    double_tap_ms: 350,
    double_tap_px: 24,
    multi_tap_ms: 350,      /* two and three finger taps are this quick */
    scroll_step_px: 24,     /* finger travel per wheel notch */
};

/* The recogniser touches neither the DOM nor the connection, so it can be
   driven by hand: positions and times in, mouse actions out through sink
   ({ move(x, y), press(button), release(button), wheel(up) }). timers is
   { set(fn, ms), clear(id) }.

   Each position comes twice. x, y are guest pixels and are what the guest
   is sent. cx, cy are the page's pixels and are what a gesture is judged
   by: a finger is as wide on a screen drawn at a third of its size as on
   one drawn in full, and a page that zooms the screen under a pinch moves
   the guest's pixels beneath fingers that have not moved at all. Left out,
   they are taken to be the same.

   A sink may also carry zoom(ratio, cx, cy) and pan(dx, dy), in page
   pixels. With zoom, two fingers moving apart or together are a pinch
   rather than a scroll; with panning() true, which a zoomed page answers,
   two fingers moving together slide the view instead of turning the wheel. */
function TouchGestures(sink, options, timers)
{
    this.sink = sink;
    this.opts = Object.assign({}, TOUCH_DEFAULTS, options || {});
    this.timers = timers || {
        set: function(fn, ms) { return window.setTimeout(fn, ms); },
        clear: function(id) { window.clearTimeout(id); },
    };
    this.points = {};
    this.count = 0;
    this.state = 'idle';
    this.held = 0;
    this.last_tap = undefined;
}

TouchGestures.prototype =
{
    down: function(id, x, y, t, cx, cy)
    {
        if (this.points[id])
            return;
        if (cx === undefined) { cx = x; cy = y; }
        this.points[id] = { x: x, y: y, x0: x, y0: y, cx: cx, cy: cy, cx0: cx, cy0: cy };
        this.count++;

        if (this.state === 'idle')
        {
            this.state = 'pending';
            this.first = id;
            this.origin = { x: x, y: y };
            this.t0 = t;
            this.arm_long_press();
        }
        else if (this.state === 'pending' || this.state === 'drag')
        {
            /* A second finger ends whatever the first was doing; a button
               left down here would turn the scroll into a drag. */
            this.disarm_long_press();
            this.let_go();
            this.state = 'multi';
            this.fingers = this.count;
            this.moved = false;
            this.mode = undefined;
            this.anchor();
            this.spread0 = this.last_spread;
            this.centre0 = this.last_centre;
        }
        else if (this.state === 'multi')
        {
            this.fingers = Math.max(this.fingers, this.count);
            this.anchor();
        }
    },

    move: function(id, x, y, t, cx, cy)
    {
        var p = this.points[id];
        if (! p)
            return;
        p.x = x;
        p.y = y;
        p.cx = cx === undefined ? x : cx;
        p.cy = cx === undefined ? y : cy;

        if (this.state === 'pending' && this.travel(p) > this.opts.slop_px)
        {
            /* The button goes down where the finger first landed, which
               is what it meant to grab, not where it was noticed moving. */
            this.disarm_long_press();
            this.state = 'drag';
            this.sink.move(p.x0, p.y0);
            this.grab(Constants.SPICE_MOUSE_BUTTON_LEFT);
            this.sink.move(x, y);
        }
        else if (this.state === 'drag' && id === this.first)
        {
            this.sink.move(x, y);
        }
        else if (this.state === 'multi')
        {
            if (! this.moved && this.travel(p) > this.opts.slop_px)
            {
                this.moved = true;
                this.mode = this.pinching() ? 'pinch' : 'scroll';
            }
            if (this.moved && this.count >= 2)
                this.two_fingers();
        }
    },

    up: function(id, x, y, t)
    {
        var p = this.points[id];
        if (! p)
            return;
        delete this.points[id];
        this.count--;
        if (this.state === 'multi' && this.count)
            this.anchor();

        if (this.state === 'pending')
        {
            this.disarm_long_press();
            this.tap(p, t);
            this.state = 'idle';
        }
        else if (this.state === 'drag' && id === this.first)
        {
            this.sink.move(x, y);
            this.let_go();
            this.state = this.count ? 'spent' : 'idle';
        }
        else if (this.count === 0)
        {
            if (this.state === 'multi' && ! this.moved && t - this.t0 <= this.opts.multi_tap_ms)
            {
                /* Where the first finger landed: the others came down
                   beside the thing being pointed at, not on it. */
                this.click(this.origin.x, this.origin.y, this.fingers >= 3 ?
                           Constants.SPICE_MOUSE_BUTTON_MIDDLE : Constants.SPICE_MOUSE_BUTTON_RIGHT);
            }
            this.state = 'idle';
        }
    },

    /* The browser took the touch away: no click, and nothing left held. */
    cancel: function(id)
    {
        if (! this.points[id])
            return;
        delete this.points[id];
        this.count--;
        this.disarm_long_press();
        this.let_go();
        this.state = this.count ? 'spent' : 'idle';
    },

    reset: function()
    {
        this.disarm_long_press();
        this.let_go();
        this.points = {};
        this.count = 0;
        this.state = 'idle';
    },

    travel: function(p)
    {
        return Math.sqrt((p.cx - p.cx0) * (p.cx - p.cx0) + (p.cy - p.cy0) * (p.cy - p.cy0));
    },

    centre: function()
    {
        var x = 0, y = 0;
        for (var id in this.points)
        {
            x += this.points[id].cx;
            y += this.points[id].cy;
        }
        return this.count ? { x: x / this.count, y: y / this.count } : { x: 0, y: 0 };
    },

    /* How far the fingers are from their centre, on average: the distance
       between two of them, but for any number. */
    spread: function()
    {
        var c = this.centre();
        var sum = 0;
        for (var id in this.points)
        {
            var p = this.points[id];
            sum += Math.sqrt((p.cx - c.x) * (p.cx - c.x) + (p.cy - c.y) * (p.cy - c.y));
        }
        return this.count ? sum / this.count : 0;
    },

    /* Measure from here: the fingers on the screen have changed, and their
       centre and spread jumped with them. */
    anchor: function()
    {
        this.last_centre = this.centre();
        this.last_spread = this.spread();
        this.scroll_y = this.last_centre.y;
    },

    /* Decided once, as the fingers first move: in a pinch they part and
       their centre stays put, in a scroll they keep their distance and the
       centre travels. */
    pinching: function()
    {
        if (! this.sink.zoom || this.count !== 2)
            return false;
        var c = this.centre();
        var parted = Math.abs(this.spread() - this.spread0) * 2;
        var travelled = Math.sqrt((c.x - this.centre0.x) * (c.x - this.centre0.x) +
                                  (c.y - this.centre0.y) * (c.y - this.centre0.y));
        return parted > travelled;
    },

    two_fingers: function()
    {
        var c = this.centre();
        var dx = c.x - this.last_centre.x;
        var dy = c.y - this.last_centre.y;

        if (this.mode === 'pinch')
        {
            /* Zoom about where the centre was, then slide to where it is:
               together, exactly the move the fingers made. In that order
               because a view at its fit has no room to slide until the
               zoom has made some. */
            var spread = this.spread();
            if (this.last_spread > 0 && spread > 0)
                this.sink.zoom(spread / this.last_spread, this.last_centre.x, this.last_centre.y);
            if (this.sink.pan && (dx || dy))
                this.sink.pan(dx, dy);
            this.last_spread = spread;
            this.scroll_y = c.y;
        }
        else if (this.sink.pan && this.sink.panning && this.sink.panning())
        {
            if (dx || dy)
                this.sink.pan(dx, dy);
            this.scroll_y = c.y;
        }
        else
        {
            var step = this.opts.scroll_step_px;
            while (Math.abs(c.y - this.scroll_y) >= step)
            {
                /* Fingers moving down pull the content down with them,
                   which is the wheel turning up. */
                var down = c.y > this.scroll_y;
                this.sink.wheel(down);
                this.scroll_y += down ? step : -step;
            }
        }
        this.last_centre = c;
    },

    tap: function(p, t)
    {
        var x = p.x0, y = p.y0;
        /* A double click is two clicks on one spot, and a guest measures
           the spot in pixels. Two taps of a finger never land that close,
           so the second goes where the first did. */
        var last = this.last_tap;
        if (last && t - last.t <= this.opts.double_tap_ms &&
            Math.abs(p.cx0 - last.cx) <= this.opts.double_tap_px &&
            Math.abs(p.cy0 - last.cy) <= this.opts.double_tap_px)
        {
            x = last.x;
            y = last.y;
            this.last_tap = undefined;
        }
        else
            this.last_tap = { x: x, y: y, cx: p.cx0, cy: p.cy0, t: t };
        this.click(x, y, Constants.SPICE_MOUSE_BUTTON_LEFT);
    },

    click: function(x, y, button)
    {
        this.sink.move(x, y);
        this.sink.press(button);
        this.sink.release(button);
    },

    grab: function(button)
    {
        this.held = button;
        this.sink.press(button);
    },

    let_go: function()
    {
        if (! this.held)
            return;
        this.sink.release(this.held);
        this.held = 0;
    },

    arm_long_press: function()
    {
        var that = this;
        this.long_press = this.timers.set(function()
        {
            that.long_press = undefined;
            if (that.state !== 'pending')
                return;
            var p = that.points[that.first];
            that.state = 'spent';
            that.last_tap = undefined;
            that.click(p.x0, p.y0, Constants.SPICE_MOUSE_BUTTON_RIGHT);
            if (that.onlongpress)
                that.onlongpress();
        }, this.opts.long_press_ms);
    },

    disarm_long_press: function()
    {
        if (this.long_press !== undefined)
            this.timers.clear(this.long_press);
        this.long_press = undefined;
    },
};

/*----------------------------------------------------------------------------
**  The screen element's side of it. Pointer events rather than touch
**  events: a finger that slides off the element stays captured to it, and
**  a mouse or a pen arriving through the same events is told apart and
**  left to the mouse handlers.
**--------------------------------------------------------------------------*/
function is_touch(e)
{
    return e.pointerType === 'touch';
}

function clamp(v, max)
{
    return Math.max(0, Math.min(max, v));
}

function hook_touch(canvas, sc)
{
    if (sc.touch_input === false || canvas.spice_touch || typeof window.PointerEvent === 'undefined')
        return;

    var sink = {
        move: function(x, y) { Inputs.pointer_move(sc, x, y); },
        press: function(button) { Inputs.pointer_press(sc, button); },
        release: function(button) { Inputs.pointer_release(sc, button); },
        wheel: function(up) { Inputs.pointer_wheel(sc, up); },
        pan: function(dx, dy) { if (sc.ontouchpan) sc.ontouchpan(dx, dy); },
        panning: function() { return !! sc.touch_panning; },
    };
    /* Only a page that will act on a pinch gets one; for any other, two
       fingers always scroll. */
    if (sc.ontouchzoom)
        sink.zoom = function(ratio, cx, cy) { sc.ontouchzoom(ratio, cx, cy); };
    var gestures = new TouchGestures(sink, sc.touch_options);
    gestures.onlongpress = function()
    {
        if (navigator.vibrate)
            navigator.vibrate(10);
    };

    /* offsetX/Y are in the element's own pixels whatever CSS scale is on
       it, the same as for the mouse. A captured finger can wander off the
       element, where they run past its edges. */
    function at(e)
    {
        return { x: clamp(Math.round(e.offsetX), canvas.width - 1),
                 y: clamp(Math.round(e.offsetY), canvas.height - 1) };
    }

    var listeners = {
        pointerdown: function(e)
        {
            if (! is_touch(e))
                return;
            /* Without this the browser follows the touch with a made-up
               mousedown and mouseup, and the guest is clicked twice. */
            e.preventDefault();
            /* The browser's own tap would have focused the screen. A page
               that raised a soft keyboard from a field of its own turns
               this off, or every tap on the guest would put it away. */
            if (sc.touch_focus !== false)
                canvas.focus({ preventScroll: true });
            try { canvas.setPointerCapture(e.pointerId); } catch (err) { }
            var p = at(e);
            gestures.down(e.pointerId, p.x, p.y, e.timeStamp, e.clientX, e.clientY);
        },
        pointermove: function(e)
        {
            if (! is_touch(e))
                return;
            e.preventDefault();
            var p = at(e);
            gestures.move(e.pointerId, p.x, p.y, e.timeStamp, e.clientX, e.clientY);
        },
        pointerup: function(e)
        {
            if (! is_touch(e))
                return;
            e.preventDefault();
            var p = at(e);
            gestures.up(e.pointerId, p.x, p.y, e.timeStamp);
        },
        pointercancel: function(e)
        {
            if (! is_touch(e))
                return;
            gestures.cancel(e.pointerId);
        },
        /* Cancelling pointerdown stops the made-up mouse events but not the
           browser's tap, which moves focus and may select or zoom. */
        touchstart: function(e) { e.preventDefault(); },
        touchend: function(e) { e.preventDefault(); },
    };

    for (var name in listeners)
        canvas.addEventListener(name, listeners[name], { passive: false });

    /* Or the browser pans and zooms the page with the touch, and cancels
       the pointer the moment it decides to. */
    var touch_action = canvas.style.touchAction;
    canvas.style.touchAction = 'none';

    canvas.spice_touch = { gestures: gestures, listeners: listeners, touch_action: touch_action };
}

function unhook_touch(canvas)
{
    var touch = canvas.spice_touch;
    if (! touch)
        return;
    touch.gestures.reset();
    for (var name in touch.listeners)
        canvas.removeEventListener(name, touch.listeners[name]);
    canvas.style.touchAction = touch.touch_action;
    canvas.spice_touch = undefined;
}

export {
  TouchGestures,
  hook_touch,
  unhook_touch,
};
