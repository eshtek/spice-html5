"use strict";
/*
   Copyright (C) 2014 by Jeremy P. White <jwhite@codeweavers.com>

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
**  SpicePlaybackConn
**      Drive the Spice Playback channel (sound out)
**--------------------------------------------------------------------------*/

import * as Utils from './utils.js';
import * as Webm from './webm.js';
import * as Messages from './spicemsg.js';
import { Constants } from './enums.js';
import { SpiceConn } from './spiceconn.js';

function SpicePlaybackConn()
{
    SpiceConn.apply(this, arguments);

    this.queue = new Array();
    this.append_okay = false;
    this.start_time = 0;

    this.data_msgs = 0;
    this.data_bytes = 0;
    this.dropped_msgs = 0;
    this.appends = 0;
    this.milestones = {};
}

SpicePlaybackConn.prototype = Object.create(SpiceConn.prototype);

/* Audio has a long chain -- START, an audio element, sourceopen, a
   source buffer, appends, then actual playback -- and every link can
   fail without raising anything. When it does the console shows
   nothing at all, which is indistinguishable from silence in the
   guest, so each link reports itself once under PLAYBACK_DEBUG. */
SpicePlaybackConn.prototype.milestone = function(name, detail)
{
    if (this.milestones[name])
        return;
    this.milestones[name] = true;
    Utils.PLAYBACK_DEBUG > 0 && console.log("Playback: " + name + (detail ? " (" + detail + ")" : ""));
}

/* Everything known about the audio pipeline, for the watchdog and for
   asking a user what their browser is doing. */
SpicePlaybackConn.prototype.status = function()
{
    var s = "reached[" + Object.keys(this.milestones).join(",") + "]" +
            " data_msgs " + this.data_msgs +
            " bytes " + this.data_bytes +
            " dropped " + this.dropped_msgs +
            " appends " + this.appends +
            " queue " + this.queue.length +
            " append_okay " + this.append_okay;
    if (this.media_source)
        s += " media_source " + Utils.dump_media_source(this.media_source);
    else
        s += " media_source none";
    if (this.source_buffer)
        s += " source_buffer yes";
    else
        s += " source_buffer NONE";
    if (this.audio)
        s += " audio " + Utils.dump_media_element(this.audio);
    else
        s += " audio none";
    return s;
}

/* The failure this exists for is the silent one: audio arriving and
   never being heard. Anything that reports itself is easier than this.
   Fires at most every 10s, and only while data is flowing but the
   element is not advancing. */
SpicePlaybackConn.prototype.check_playing = function()
{
    if (this.data_msgs < 25)
        return;

    var playing = this.audio && ! this.audio.paused && this.audio.currentTime > 0;
    if (playing)
    {
        this.milestone("playing");
        this.remove_gesture_listeners();
        return;
    }

    var now = Date.now();
    if (this.last_stall_report && now - this.last_stall_report < 10000)
        return;
    this.last_stall_report = now;

    /* Backstop for a pause we never saw an event for. The event
       handler below is the primary path; this one is spaced by the
       report throttle so the attempts are seconds apart rather than
       three in the same millisecond. */
    this.retry_paused_playback();

    this.log_err("Audio is arriving but not playing. " + this.status());
}

SpicePlaybackConn.prototype.process_channel_message = function(msg)
{
    if (!window.MediaSource)
    {
        this.log_err('MediaSource API is not available');
        return false;
    }

    if (msg.type == Constants.SPICE_MSG_PLAYBACK_START)
    {
        var start = new Messages.SpiceMsgPlaybackStart(msg.data);

        Utils.PLAYBACK_DEBUG > 0 && console.log("PlaybackStart; frequency " + start.frequency);

        if (start.frequency != Webm.Constants.OPUS_FREQUENCY)
        {
            this.log_err('This player cannot handle frequency ' + start.frequency);
            return false;
        }

        if (start.channels != Webm.Constants.OPUS_CHANNELS)
        {
            this.log_err('This player cannot handle ' + start.channels + ' channels');
            return false;
        }

        if (start.format != Constants.SPICE_AUDIO_FMT_S16)
        {
            this.log_err('This player cannot format ' + start.format);
            return false;
        }

        this.milestone("start", "freq " + start.frequency + " channels " +
                                start.channels + " format " + start.format);

        /* Audio again before the idle timer fired: keep the element we
           already have, which is already past the autoplay policy. */
        this.cancel_idle_teardown();

        /* Keyed on the audio element, not source_buffer: source_buffer is
           only set asynchronously in handle_source_open, so a second START
           arriving before sourceopen would stack a second audio element. */
        if (! this.audio)
        {
            this.media_source = new MediaSource();
            this.media_source.spiceconn = this;

            this.audio = document.createElement("audio");
            this.audio.spiceconn = this;
            this.audio.setAttribute('autoplay', true);
            this.audio.src = window.URL.createObjectURL(this.media_source);
            document.getElementById(this.parent.screen_id).appendChild(this.audio);

            this.media_source.addEventListener('sourceopen', handle_source_open, false);
            this.media_source.addEventListener('sourceended', handle_source_ended, false);
            this.media_source.addEventListener('sourceclosed', handle_source_closed, false);

            this.bytes_written = 0;
            this.tearing_down = false;
            this.replay_attempts = 0;
            this.milestone("audio-element");

            /* sourceopen is the link that fails most quietly: without it
               there is no source buffer, and every data message below is
               discarded with nothing said. */
            var conn = this;
            window.setTimeout(function ()
            {
                if (! conn.source_buffer && conn.audio)
                    conn.log_err("Playback: sourceopen never fired after 5s; " +
                                 "no audio can be decoded. " + conn.status());
            }, 5000);

            /* The autoplay attribute alone is not enough. The page usually opens in
               its own tab, so the audio element is created before
               anything has been clicked inside it, and every browser's
               autoplay policy then refuses to start audible playback. The
               attribute's failure is silent -- no event, no exception, the
               element simply stays paused -- which presents as a client
               that is connected, painting, and mute forever. Drive playback
               explicitly instead, and if it is refused, start it on the
               first interaction with the page. */
            this.try_play();
        }

        /* Reusing an existing element is a handled START too. Falling
           through here reported the message as unhandled, which is now
           the common case rather than a rarity. */
        return true;
    }

    if (msg.type == Constants.SPICE_MSG_PLAYBACK_DATA)
    {
        var data = new Messages.SpiceMsgPlaybackData(msg.data);

        this.data_msgs++;
        this.data_bytes += data.data.byteLength;
        this.milestone("data");

        /* Audio the browser will never hear. Silently dropping this is
           how 400KB of guest audio can arrive with the console showing
           nothing whatsoever. */
        if (! this.source_buffer)
        {
            this.dropped_msgs++;
            if (this.dropped_msgs == 50)
                this.log_err("Playback: dropped 50 audio messages, no source buffer yet. " +
                             this.status());
            return true;
        }

        this.check_playing();

        if (this.audio.readyState >= 3 && this.audio.buffered.length > 1 &&
            this.audio.currentTime == this.audio.buffered.end(0) &&
            this.audio.currentTime < this.audio.buffered.start(this.audio.buffered.length - 1))
        {
            console.log("Audio underrun: we appear to have fallen behind; advancing to " +
                this.audio.buffered.start(this.audio.buffered.length - 1));
            this.audio.currentTime = this.audio.buffered.start(this.audio.buffered.length - 1);
        }

        /* Around version 45, Firefox started being very particular about the
           time stamps put into the Opus stream.  The time stamps from the Spice server are
           somewhat irregular.  They mostly arrive every 10 ms, but sometimes it is 11, or sometimes
           with two time stamps the same in a row.  The previous logic resulted in fuzzy and/or
           distorted audio streams in Firefox in a row.

           In theory, the sequence mode should be appropriate for us, but as of 09/27/2016,
           I was unable to make sequence mode work with Firefox.

           Thus, we end up with an inelegant hack.  Essentially, we force every packet to have
           a 10ms time delta, unless there is an obvious gap in time stream, in which case we
           will resync.
        */

        if (this.start_time != 0 && data.time != (this.last_data_time + Webm.Constants.EXPECTED_PACKET_DURATION))
        {
            if (Math.abs(data.time - (Webm.Constants.EXPECTED_PACKET_DURATION + this.last_data_time)) < Webm.Constants.MAX_CLUSTER_TIME)
            {
                Utils.PLAYBACK_DEBUG > 1 && console.log("Hacking time of " + data.time + " to " +
                                      (this.last_data_time + Webm.Constants.EXPECTED_PACKET_DURATION));
                data.time = this.last_data_time + Webm.Constants.EXPECTED_PACKET_DURATION;
            }
            else
            {
                Utils.PLAYBACK_DEBUG > 1 && console.log("Apparent gap in audio time; now is " + data.time + " last was " + this.last_data_time);
            }
        }

        this.last_data_time = data.time;

        Utils.PLAYBACK_DEBUG > 1 && console.log("PlaybackData; time " + data.time + "; length " + data.data.byteLength);

        if (this.start_time == 0)
            this.start_playback(data);

        else if (data.time - this.cluster_time >= Webm.Constants.MAX_CLUSTER_TIME)
            this.new_cluster(data);

        else
            this.simple_block(data, false);

        return true;
    }

    if (msg.type == Constants.SPICE_MSG_PLAYBACK_MODE)
    {
        var mode = new Messages.SpiceMsgPlaybackMode(msg.data);
        if (mode.mode != Constants.SPICE_AUDIO_DATA_MODE_OPUS)
        {
            this.log_err('This player cannot handle mode ' + mode.mode);
            /* Deleting just source_buffer left the audio element and its
               object URL orphaned with no guard left to reclaim them. */
            this.destroy_audio();
        }
        return true;
    }

    if (msg.type == Constants.SPICE_MSG_PLAYBACK_STOP)
    {
        Utils.PLAYBACK_DEBUG > 0 && console.log("PlaybackStop");

        /* A stop is not the end of audio, it is the guest closing its
           output device -- which applications do constantly, around
           every individual sound. Tearing the pipeline down here meant
           the next sound built a brand new audio element, and a new
           element faces the autoplay policy again from scratch: on
           Firefox every cycle came back paused, so a guest that toggles
           its device (Audacity around each playback) was silent while
           one holding the device open (a video) played fine.

           Keep the element and let it idle. Timestamps come from the
           server's monotonic clock, so a later stream continues the
           same WebM stream across the gap, which new_cluster already
           resynchronises. Only a guest that stays quiet for a while
           gets the element reclaimed. */
        this.schedule_idle_teardown();
        return true;
    }

    if (msg.type == Constants.SPICE_MSG_PLAYBACK_VOLUME)
    {
        this.known_unimplemented(msg.type, "Playback Volume");
        return true;
    }

    if (msg.type == Constants.SPICE_MSG_PLAYBACK_MUTE)
    {
        this.known_unimplemented(msg.type, "Playback Mute");
        return true;
    }

    if (msg.type == Constants.SPICE_MSG_PLAYBACK_LATENCY)
    {
        this.known_unimplemented(msg.type, "Playback Latency");
        return true;
    }

    return false;
}

/* Start playback, and if the browser refuses, retry once the user
   interacts. The listeners are capturing and passive so they see the
   gesture wherever it lands -- the page's own handlers stop plenty of
   events from bubbling -- and they are torn down on the first success or
   when the element goes away, so a page that never plays audio does
   not keep them forever. */
SpicePlaybackConn.prototype.try_play = function()
{
    if (! this.audio)
        return;

    var conn = this;
    var p = this.audio.play();

    /* play() predates promises in some engines. */
    if (! p || typeof p.catch !== 'function')
        return;

    p.then(function ()
    {
        /* Deliberately does NOT drop the gesture listeners. A resolved
           play() is not proof of playback: Firefox resolves it while
           the element is still inaudible -- an empty MediaSource has no
           audio track yet -- and applies its autoplay policy later, the
           moment the opus track arrives and the element would make
           sound, pausing it then. Treating resolution as success tore
           down the retry and left the console mute with a full buffer,
           no error, and a promise that had said yes. They are dropped
           in check_playing once the element is genuinely advancing. */
        conn.milestone("play-accepted");
    })
    .catch(function (e)
    {
        /* AbortError just means a newer load superseded this attempt --
           the element is still live and the next attempt covers it. */
        if (e && e.name === 'AbortError')
            return;

        if (! conn.gesture_listener)
        {
            /* Reported unconditionally: a refused autoplay is the most
               common reason a client is connected and mute, and gating
               it behind a debug flag hid exactly the case a user is
               trying to explain. */
            console.log("Playback: autoplay refused (" + (e && e.name) +
                        "); audio will start on the first click or keypress.");
            conn.gesture_listener = function ()
            {
                conn.remove_gesture_listeners();
                conn.try_play();
            };
            var opts = { capture: true, passive: true };
            document.addEventListener('pointerdown', conn.gesture_listener, opts);
            document.addEventListener('keydown', conn.gesture_listener, opts);
        }
    });
}

/* Long enough that an application cycling its output device around
   individual sounds never loses the element, short enough that a guest
   which has genuinely finished with audio does not hold one open. */
var PLAYBACK_IDLE_TEARDOWN_MS = 30000;

SpicePlaybackConn.prototype.schedule_idle_teardown = function()
{
    if (! this.audio || this.idle_timer)
        return;

    var conn = this;
    this.idle_timer = window.setTimeout(function ()
    {
        conn.idle_timer = undefined;
        Utils.PLAYBACK_DEBUG > 0 && console.log("Playback: idle, releasing the audio element");
        conn.destroy_audio();
    }, PLAYBACK_IDLE_TEARDOWN_MS);
}

SpicePlaybackConn.prototype.cancel_idle_teardown = function()
{
    if (! this.idle_timer)
        return;
    window.clearTimeout(this.idle_timer);
    this.idle_timer = undefined;
}

/* A browser that paused us after accepting play() gets another
   attempt. If it refuses this one it does so through the promise,
   which arms the gesture retry, so this is bounded: a browser that
   will not start without a gesture must not be asked forever. */
SpicePlaybackConn.prototype.retry_paused_playback = function()
{
    if (! this.audio || ! this.audio.paused || this.gesture_listener || this.tearing_down)
        return;

    /* Space the attempts. The pause event can arrive several times in
       the same millisecond, and three retries inside one millisecond
       spends the whole budget before the browser has settled. */
    var now = Date.now();
    if (this.last_replay_attempt && now - this.last_replay_attempt < 500)
        return;
    this.last_replay_attempt = now;

    this.replay_attempts = (this.replay_attempts || 0) + 1;
    if (this.replay_attempts > 3)
        return;

    Utils.PLAYBACK_DEBUG > 0 && console.log("Playback: element paused with audio buffered; retrying play (" +
                this.replay_attempts + "/3)");
    this.try_play();
}

SpicePlaybackConn.prototype.remove_gesture_listeners = function()
{
    if (! this.gesture_listener)
        return;
    var opts = { capture: true };
    document.removeEventListener('pointerdown', this.gesture_listener, opts);
    document.removeEventListener('keydown', this.gesture_listener, opts);
    this.gesture_listener = undefined;
}

SpicePlaybackConn.prototype.destroy_audio = function()
{
    this.remove_gesture_listeners();
    this.cancel_idle_teardown();

    if (! this.audio)
        return;

    /* Tearing the element down pauses it; without this the pause
       handler would read that as a browser stopping us and try to
       restart an element being disposed of. */
    this.tearing_down = true;

    if (this.audio.parentNode)
        this.audio.parentNode.removeChild(this.audio);
    window.URL.revokeObjectURL(this.audio.src);

    delete this.source_buffer;
    delete this.media_source;
    delete this.audio;

    this.append_okay = false;
    this.queue = new Array();
    this.start_time = 0;
}

/* A client-side stop must reclaim the audio element, its object URL and
   the MediaSource; without this they were only freed by a server STOP,
   and an application that stops and recreates connections leaked one
   set per cycle. */
SpicePlaybackConn.prototype.cleanup = function()
{
    this.destroy_audio();
    SpiceConn.prototype.cleanup.call(this);
}

SpicePlaybackConn.prototype.start_playback = function(data)
{
    this.start_time = data.time;

    var h = new Webm.Header();
    var te = new Webm.AudioTrackEntry;
    var t = new Webm.Tracks(te);

    var mb = new ArrayBuffer(h.buffer_size() + t.buffer_size())

    this.bytes_written = h.to_buffer(mb);
    this.bytes_written = t.to_buffer(mb, this.bytes_written);

    this.source_buffer.addEventListener('error', handle_sourcebuffer_error, false);
    this.source_buffer.addEventListener('updateend', handle_append_buffer_done, false);
    playback_append_buffer(this, mb);

    this.new_cluster(data);
}

SpicePlaybackConn.prototype.new_cluster = function(data)
{
    this.cluster_time = data.time;

    var c = new Webm.Cluster(data.time - this.start_time);

    var mb = new ArrayBuffer(c.buffer_size());
    this.bytes_written += c.to_buffer(mb);

    if (this.append_okay)
        playback_append_buffer(this, mb);
    else
        this.queue.push(mb);

    this.simple_block(data, true);
}

SpicePlaybackConn.prototype.simple_block = function(data, keyframe)
{
    var sb = new Webm.SimpleBlock(data.time - this.cluster_time, data.data, keyframe);
    var mb = new ArrayBuffer(sb.buffer_size());

    this.bytes_written += sb.to_buffer(mb);

    if (this.append_okay)
        playback_append_buffer(this, mb);
    else
        this.queue.push(mb);
}

function handle_source_open(e)
{
    var p = this.spiceconn;

    if (p.source_buffer)
        return;

    p.milestone("sourceopen");

    try
    {
        p.source_buffer = this.addSourceBuffer(Webm.Constants.SPICE_PLAYBACK_CODEC);
    }
    catch (e)
    {
        /* addSourceBuffer throws rather than returning null when the
           codec is refused, so the null check below never ran and the
           rejection propagated as an unhandled exception out of an
           event handler -- invisible unless the console was open on
           the right filter. */
        p.log_err('Codec ' + Webm.Constants.SPICE_PLAYBACK_CODEC +
                  ' refused by addSourceBuffer: ' + e);
        return;
    }

    if (! p.source_buffer)
    {
        p.log_err('Codec ' + Webm.Constants.SPICE_PLAYBACK_CODEC + ' not available.');
        return;
    }

    p.milestone("source-buffer");

    if (Utils.PLAYBACK_DEBUG > 0)
        playback_handle_event_debug.call(this, e);

    listen_for_audio_events(p);

    p.source_buffer.spiceconn = p;
    p.source_buffer.mode = "segments";

    // FIXME - Experimentation with segments and sequences was unsatisfying.
    //         Switching to sequence did not solve our gap problem,
    //         but the browsers didn't fully support the time seek capability
    //         we would expect to gain from 'segments'.
    //         Segments worked at the time of this patch, so segments it is for now.

}

function handle_source_ended(e)
{
    var p = this.spiceconn;
    p.log_err('Audio source unexpectedly ended.');
}

function handle_source_closed(e)
{
    var p = this.spiceconn;
    p.log_err('Audio source unexpectedly closed.');
}

function condense_playback_queue(queue)
{
    if (queue.length == 1)
        return queue.shift();

    var len = 0;
    var i = 0;
    for (i = 0; i < queue.length; i++)
        len += queue[i].byteLength;

    var mb = new ArrayBuffer(len);
    var tmp = new Uint8Array(mb);
    len = 0;
    for (i = 0; i < queue.length; i++)
    {
        tmp.set(new Uint8Array(queue[i]), len);
        len += queue[i].byteLength;
    }
    queue.length = 0;
    return mb;
}

function handle_append_buffer_done(e)
{
    var p = this.spiceconn;

    if (Utils.PLAYBACK_DEBUG > 1)
        playback_handle_event_debug.call(this, e);

    if (p.queue.length > 0)
    {
        var mb = condense_playback_queue(p.queue);
        playback_append_buffer(p, mb);
    }
    else
        p.append_okay = true;

}

function handle_sourcebuffer_error(e)
{
    var p = this.spiceconn;
    p.log_err('source_buffer error ' + e.message);
}

function playback_append_buffer(p, b)
{
    try
    {
        p.source_buffer.appendBuffer(b);
        p.append_okay = false;
        p.appends++;
        p.milestone("append");
    }
    catch (e)
    {
        p.log_err("Error invoking appendBuffer: " + e.message);
    }
}

function playback_handle_event_debug(e)
{
    var p = this.spiceconn;
    if (p.audio)
    {
        if (Utils.PLAYBACK_DEBUG > 0 || p.audio.buffered.len > 1)
            console.log(p.audio.currentTime + ": event " + e.type +
                Utils.dump_media_element(p.audio));
    }

    if (Utils.PLAYBACK_DEBUG > 1 && p.media_source)
        console.log("  media_source " + Utils.dump_media_source(p.media_source));

    if (Utils.PLAYBACK_DEBUG > 1 && p.source_buffer)
        console.log("  source_buffer " + Utils.dump_source_buffer(p.source_buffer));

    if (Utils.PLAYBACK_DEBUG > 0 || p.queue.length > 1)
        console.log('  queue len ' + p.queue.length + '; append_okay: ' + p.append_okay);
}

function playback_debug_listen_for_one_event(name)
{
    this.addEventListener(name, playback_handle_event_debug);
}

/* The element's own error is the only report a browser gives when it
   rejects the stream we built, and it was routed to the debug logger,
   which says nothing unless PLAYBACK_DEBUG is raised. A browser that
   refused the audio therefore looked exactly like a browser playing it
   silently -- no error, no event, no clue. Always report it. */
function handle_audio_element_error()
{
    var p = this.spiceconn;
    var err = this.error;
    if (! err)
    {
        p.log_err('Audio element failed with no error set.');
        return;
    }

    var names = {1: 'ABORTED', 2: 'NETWORK', 3: 'DECODE', 4: 'SRC_NOT_SUPPORTED'};
    p.log_err('Audio element error ' + err.code + ' (' +
              (names[err.code] || 'unknown') + ')' +
              (err.message ? ': ' + err.message : ''));
}

/* The moment Firefox's autoplay policy takes effect: it accepts play()
   on a still-silent element, then pauses it here, once the opus track
   arrives and the element would actually make sound. Nothing else
   pauses this element -- there is no UI for it -- so an unsolicited
   pause means a browser stopped us and is worth one more attempt. */
function handle_audio_element_pause()
{
    var p = this.spiceconn;
    if (! p || ! p.audio)
        return;
    p.milestone("paused-by-browser");
    p.retry_paused_playback();
}

function listen_for_audio_events(spiceconn)
{
    spiceconn.audio.addEventListener('error', handle_audio_element_error);
    spiceconn.audio.addEventListener('pause', handle_audio_element_pause);

    var audio_0_events = [
        "abort", "error"
    ];

    var audio_1_events = [
        "loadstart", "suspend", "emptied", "stalled", "loadedmetadata", "loadeddata", "canplay",
        "canplaythrough", "playing", "waiting", "seeking", "seeked", "ended", "durationchange",
        "timeupdate", "play", "pause", "ratechange"
    ];

    var audio_2_events = [
        "progress",
        "resize",
        "volumechange"
    ];

    audio_0_events.forEach(playback_debug_listen_for_one_event, spiceconn.audio);
    if (Utils.PLAYBACK_DEBUG > 0)
        audio_1_events.forEach(playback_debug_listen_for_one_event, spiceconn.audio);
    if (Utils.PLAYBACK_DEBUG > 1)
        audio_2_events.forEach(playback_debug_listen_for_one_event, spiceconn.audio);
}

export {
  SpicePlaybackConn,
};
