"use strict";
/*
   Copyright (C) 2026 Eshtek, Inc.

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
**  SpiceRecordConn
**      Drive the Spice Record channel (sound in: client microphone -> guest)
**
**  The server opens capture with RECORD_START carrying the format it wants
**  (channels / S16 / frequency) and closes it with RECORD_STOP; the guest
**  toggling its mic (e.g. joining a voice call) cycles these repeatedly, so
**  capture setup and teardown must be re-entrant.  We reply with RECORD_MODE
**  + RECORD_START_MARK, then a stream of RECORD_DATA.
**
**  Audio is pulled through an AudioWorklet (the render thread), which
**  resamples to the negotiated frequency and posts fixed 480-sample planar
**  frames here.  480 samples is SND_CODEC_OPUS_FRAME_SIZE: in Opus mode each
**  frame becomes exactly one RECORD_DATA message, because the server decodes
**  each message as one codec frame and its decode buffer is one frame deep.
**  In raw mode framing is free, so frames are batched per message to halve
**  the message rate.
**
**  Opus (via WebCodecs) is used only when every gate passes: the server
**  advertised SPICE_RECORD_CAP_OPUS, the negotiated frequency is 48000 (the
**  only rate the server's codec table accepts), and the encoder demonstrably
**  emits 10ms frames -- the first encoded chunk is inspected before
**  RECORD_MODE is committed, and anything unexpected falls back to raw.
**  Raw S16 at 48kHz stereo is ~187KB/s upstream; Opus is ~8KB/s.
**--------------------------------------------------------------------------*/

import * as Utils from './utils.js';
import * as Messages from './spicemsg.js';
import { Constants } from './enums.js';
import { SpiceConn } from './spiceconn.js';

var RECORD_FRAME_SAMPLES = 480;      /* SND_CODEC_OPUS_FRAME_SIZE; 10ms at 48kHz */
var RECORD_RAW_FRAMES_PER_MSG = 2;   /* 20ms per raw RECORD_DATA message */
var RECORD_OPUS_FRAME_US = 10000;
var RECORD_OPUS_MAX_BYTES = 480;     /* SND_CODEC_OPUS_COMPRESSED_FRAME_BYTES */
var RECORD_OPUS_BITRATE = 64000;
var RECORD_MAX_PROBE_FRAMES = 8;     /* give up on the encoder probe after 80ms */

/* Runs on the audio render thread.  Maps the microphone's channel layout
   onto the negotiated one, linearly resamples if the context could not be
   opened at the negotiated rate, and posts planar frames of exactly
   frameSize samples.  The node keeps a silent output and is wired to the
   destination because a worklet with dangling outputs is not reliably
   pulled by every browser's renderer; nothing is ever written to the
   output, so the microphone is not looped back to the speakers. */
var RECORD_WORKLET_SOURCE = `
registerProcessor('spice-record-capture', class extends AudioWorkletProcessor {
    constructor(options)
    {
        super();
        var opts = options.processorOptions;
        this.channels = opts.channels;
        this.frameSize = opts.frameSize;
        this.ratio = sampleRate / opts.targetRate;
        this.frac = 0;
        this.last = new Float32Array(this.channels);
        this.acc = [];
        for (var c = 0; c < this.channels; c++)
            this.acc.push(new Float32Array(this.frameSize));
        this.accLen = 0;
    }

    push_sample(frame_at, srcs, k, t)
    {
        for (var c = 0; c < this.channels; c++)
        {
            var s = srcs[c];
            var a = k === 0 ? this.last[c] : s[k - 1];
            var b = s[k];
            this.acc[c][frame_at] = t === 0 ? b : a + (b - a) * t;
        }
    }

    flush_if_full()
    {
        if (this.accLen < this.frameSize)
            return;
        var frames = this.acc;
        var transfer = [];
        for (var c = 0; c < this.channels; c++)
            transfer.push(frames[c].buffer);
        this.port.postMessage({ f: frames }, transfer);
        this.acc = [];
        for (var c = 0; c < this.channels; c++)
            this.acc.push(new Float32Array(this.frameSize));
        this.accLen = 0;
    }

    process(inputs)
    {
        var input = inputs[0];
        if (!input || input.length === 0 || !input[0] || input[0].length === 0)
            return true;

        /* Mic layouts rarely match the negotiated one: duplicate mono up,
           take the first channels of anything wider. */
        var srcs = [];
        for (var c = 0; c < this.channels; c++)
            srcs.push(input[Math.min(c, input.length - 1)]);

        var n = srcs[0].length;
        var pos = this.frac;
        while (pos < n)
        {
            var k = Math.floor(pos);
            this.push_sample(this.accLen, srcs, k, pos - k);
            this.accLen++;
            this.flush_if_full();
            pos += this.ratio;
        }
        this.frac = pos - n;
        for (var c = 0; c < this.channels; c++)
            this.last[c] = srcs[c][n - 1];
        return true;
    }
});
`;

function SpiceRecordConn()
{
    SpiceConn.apply(this, arguments);

    this.generation = 0;
    this.capturing = false;

    /* Whatever happens to the transport, the mic must not stay held: the
       OS capture indicator outliving the console is a privacy bug. */
    this.ws.addEventListener('close', this.stop_capture.bind(this));
}

SpiceRecordConn.prototype = Object.create(SpiceConn.prototype);
SpiceRecordConn.prototype.process_channel_message = function(msg)
{
    if (msg.type == Constants.SPICE_MSG_RECORD_START)
    {
        var start = new Messages.SpiceMsgRecordStart(msg.data);
        Utils.DEBUG > 0 && console.log("RecordStart; channels " + start.channels +
                                       " format " + start.format + " frequency " + start.frequency);

        if (start.format != Constants.SPICE_AUDIO_FMT_S16)
        {
            this.log_err('This microphone cannot handle format ' + start.format);
            return true;
        }

        /* A START while capture is already live (or still starting) would
           stack a second pipeline; restart cleanly instead. */
        this.stop_capture();
        this.start_capture(start);
        return true;
    }

    if (msg.type == Constants.SPICE_MSG_RECORD_STOP)
    {
        Utils.DEBUG > 0 && console.log("RecordStop");
        this.stop_capture();
        return true;
    }

    /* Sent only if we advertised SPICE_RECORD_CAP_VOLUME, which we do not,
       but tolerate a server that sends them anyway. */
    if (msg.type == Constants.SPICE_MSG_RECORD_VOLUME)
    {
        this.known_unimplemented(msg.type, "Record Volume");
        return true;
    }
    if (msg.type == Constants.SPICE_MSG_RECORD_MUTE)
    {
        this.known_unimplemented(msg.type, "Record Mute");
        return true;
    }

    return false;
}

SpiceRecordConn.prototype.start_capture = function(start)
{
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia)
    {
        this.log_err('MediaDevices API is not available; microphone disabled');
        return;
    }

    var generation = ++this.generation;
    this.capturing = true;

    var conn = this;
    this.do_start_capture(start, generation).catch(function(e)
    {
        /* NotAllowedError is the user declining the permission prompt; the
           console stays usable, just without a mic. */
        conn.log_err('Microphone capture failed: ' + e);
        if (generation == conn.generation)
            conn.stop_capture();
    });
}

/* What a generation that lost the race releases: only what it acquired
   itself. The instance fields may already belong to a newer generation
   that got past getUserMedia while this one was awaiting, and the
   STOP that made this one stale has released the old ones already. */
function release_stale(stream, ctx)
{
    if (stream)
        stream.getTracks().forEach(function(t) { t.stop(); });
    if (ctx && ctx.state !== 'closed')
        ctx.close().catch(function() { });
}

SpiceRecordConn.prototype.do_start_capture = async function(start, generation)
{
    var stream = await navigator.mediaDevices.getUserMedia({
        audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: { ideal: start.channels },
            sampleRate: { ideal: start.frequency },
        }
    });

    /* Every await is a window for a STOP (or a newer START) to have
       arrived; a stale generation must release anything it acquired and
       touch nothing else. */
    if (generation != this.generation)
    {
        stream.getTracks().forEach(function(t) { t.stop(); });
        return;
    }
    this.stream = stream;

    /* Ask the context for the negotiated rate outright; when granted, the
       browser does the resampling and the worklet's ratio is 1. */
    var ctx;
    try
    {
        ctx = new AudioContext({ sampleRate: start.frequency, latencyHint: 'interactive' });
    }
    catch (e)
    {
        ctx = new AudioContext({ latencyHint: 'interactive' });
    }
    this.audio_ctx = ctx;

    var worklet_url = URL.createObjectURL(
        new Blob([RECORD_WORKLET_SOURCE], { type: 'application/javascript' }));
    try
    {
        await ctx.audioWorklet.addModule(worklet_url);
    }
    finally
    {
        URL.revokeObjectURL(worklet_url);
    }
    if (ctx.state === 'suspended')
        await ctx.resume();
    if (generation != this.generation)
    {
        release_stale(stream, ctx);
        return;
    }

    this.frames_sent = 0;
    this.raw_pending = [];
    this.mode_decided = false;
    this.probe_frames = [];
    this.probe_fed = 0;

    /* Opus is attempted only when every precondition holds; the final
       commit still waits for the probe of the first encoded chunk. */
    this.try_opus = start.frequency == 48000 &&
                    window.AudioEncoder !== undefined &&
                    this.server_has_opus_cap();
    this.start_info = start;

    if (this.try_opus)
        await this.setup_encoder(start, generation);
    if (generation != this.generation)
    {
        release_stale(stream, ctx);
        return;
    }
    if (!this.try_opus)
        this.commit_mode(Constants.SPICE_AUDIO_DATA_MODE_RAW);

    var source = ctx.createMediaStreamSource(stream);
    var node = new AudioWorkletNode(ctx, 'spice-record-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        processorOptions: {
            channels: start.channels,
            frameSize: RECORD_FRAME_SAMPLES,
            targetRate: start.frequency,
        }
    });
    node.port.onmessage = this.handle_frame.bind(this, generation);
    source.connect(node);
    node.connect(ctx.destination);
    this.source_node = source;
    this.worklet_node = node;

    Utils.DEBUG > 0 && console.log("Record capture started; context rate " + ctx.sampleRate +
                                   (this.try_opus ? "; probing opus" : "; raw mode"));
}

SpiceRecordConn.prototype.server_has_opus_cap = function()
{
    if (!this.reply_link || !this.reply_link.channel_caps || this.reply_link.channel_caps.length < 1)
        return false;
    return (this.reply_link.channel_caps[0] & (1 << Constants.SPICE_RECORD_CAP_OPUS)) != 0;
}

SpiceRecordConn.prototype.setup_encoder = async function(start, generation)
{
    var config = {
        codec: 'opus',
        sampleRate: start.frequency,
        numberOfChannels: start.channels,
        bitrate: RECORD_OPUS_BITRATE,
        opus: { frameDuration: RECORD_OPUS_FRAME_US },
    };

    try
    {
        var support = await AudioEncoder.isConfigSupported(config);
        if (!support.supported)
        {
            this.try_opus = false;
            return;
        }
    }
    catch (e)
    {
        this.try_opus = false;
        return;
    }
    if (generation != this.generation)
        return;

    var conn = this;
    this.encoder = new AudioEncoder({
        output: function(chunk) { conn.handle_encoded_chunk(generation, chunk); },
        error: function(e) { conn.handle_encoder_error(generation, e); },
    });
    this.encoder.configure(config);
}

/* All frames flow through here from the worklet: 480-sample planar
   Float32 per channel. */
SpiceRecordConn.prototype.handle_frame = function(generation, e)
{
    if (generation != this.generation)
        return;

    var frames = e.data.f;

    if (this.encoder)
    {
        this.feed_encoder(frames);
        return;
    }
    this.send_raw_frame(frames);
}

SpiceRecordConn.prototype.feed_encoder = function(frames)
{
    var ch = frames.length;
    var planar = new Float32Array(ch * RECORD_FRAME_SAMPLES);
    for (var c = 0; c < ch; c++)
        planar.set(frames[c], c * RECORD_FRAME_SAMPLES);

    var audio_data = new AudioData({
        format: 'f32-planar',
        sampleRate: this.start_info.frequency,
        numberOfFrames: RECORD_FRAME_SAMPLES,
        numberOfChannels: ch,
        timestamp: Math.round(this.frames_sent * RECORD_FRAME_SAMPLES / this.start_info.frequency * 1e6),
        data: planar,
    });
    this.frames_sent++;
    this.encoder.encode(audio_data);
    audio_data.close();

    /* Mode is committed off the first *output* chunk; if the encoder eats
       this many frames without producing one, treat it as broken.  Keeping
       the raw copies of the probe input would only preserve ~80ms of
       leading audio, so they are dropped on fallback. */
    if (!this.mode_decided)
    {
        this.probe_fed++;
        if (this.probe_fed > RECORD_MAX_PROBE_FRAMES)
            this.abandon_opus('encoder produced no output during probe');
    }
}

SpiceRecordConn.prototype.handle_encoded_chunk = function(generation, chunk)
{
    if (generation != this.generation)
        return;

    if (!this.mode_decided)
    {
        /* The Opus frame contract with the server is exact: one 10ms frame
           per message, compressed size within the server's decode buffer.
           An encoder that ignored frameDuration shows up right here. */
        var duration_ok = !chunk.duration || Math.abs(chunk.duration - RECORD_OPUS_FRAME_US) <= 1000;
        if (!duration_ok || chunk.byteLength > RECORD_OPUS_MAX_BYTES)
        {
            this.abandon_opus('encoder emitted ' + chunk.duration + 'us/' +
                              chunk.byteLength + 'B frames');
            return;
        }
        this.commit_mode(Constants.SPICE_AUDIO_DATA_MODE_OPUS);
    }

    var data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    this.send_data(data);
}

SpiceRecordConn.prototype.handle_encoder_error = function(generation, e)
{
    if (generation != this.generation)
        return;
    if (!this.mode_decided)
    {
        this.abandon_opus('encoder error: ' + e.message);
        return;
    }
    /* Mid-stream encoder death after opus was committed: the mode cannot
       be renegotiated within this capture, so stop; the server will
       re-issue RECORD_START on the guest's next capture cycle. */
    this.log_err('Opus encoder failed mid-capture: ' + e.message);
    this.stop_capture();
}

SpiceRecordConn.prototype.abandon_opus = function(reason)
{
    Utils.DEBUG > 0 && console.log("Record: falling back to raw audio (" + reason + ")");
    if (this.encoder)
    {
        try { this.encoder.close(); } catch (e) { }
        this.encoder = null;
    }
    this.commit_mode(Constants.SPICE_AUDIO_DATA_MODE_RAW);
}

/* RECORD_MODE must precede any RECORD_DATA, and the mode cannot change
   afterwards, which is why the opus decision is settled before this. */
SpiceRecordConn.prototype.commit_mode = function(mode)
{
    if (this.mode_decided)
        return;
    this.mode_decided = true;

    var msg = new Messages.SpiceMiniData();
    msg.build_msg(Constants.SPICE_MSGC_RECORD_MODE,
                  new Messages.SpiceMsgcRecordMode(Math.round(performance.now()), mode));
    this.send_msg(msg);

    msg = new Messages.SpiceMiniData();
    msg.build_msg(Constants.SPICE_MSGC_RECORD_START_MARK,
                  new Messages.SpiceMsgcRecordStartMark(Math.round(performance.now())));
    this.send_msg(msg);
}

SpiceRecordConn.prototype.send_raw_frame = function(frames)
{
    this.raw_pending.push(frames);
    if (this.raw_pending.length < RECORD_RAW_FRAMES_PER_MSG)
        return;

    var pending = this.raw_pending;
    this.raw_pending = [];

    var ch = pending[0].length;
    var total_samples = RECORD_FRAME_SAMPLES * pending.length;

    /* Interleaved S16LE, the layout SpiceMsgPlaybackPacket raw data uses:
       L R L R for stereo, not one channel after the other. */
    var out = new Int16Array(total_samples * ch);
    var at = 0;
    for (var p = 0; p < pending.length; p++)
    {
        var planes = pending[p];
        for (var i = 0; i < RECORD_FRAME_SAMPLES; i++)
            for (var c = 0; c < ch; c++)
            {
                var s = planes[c][i];
                s = s < -1 ? -1 : (s > 1 ? 1 : s);
                out[at++] = s * 0x7FFF;
            }
    }
    this.frames_sent += pending.length;
    this.send_data(new Uint8Array(out.buffer));
}

SpiceRecordConn.prototype.send_data = function(u8)
{
    var msg = new Messages.SpiceMiniData();
    msg.build_msg(Constants.SPICE_MSGC_RECORD_DATA,
                  new Messages.SpiceMsgcRecordData(Math.round(performance.now()), u8));
    this.send_msg(msg);
}

SpiceRecordConn.prototype.release_capture_resources = function()
{
    if (this.worklet_node)
    {
        this.worklet_node.port.onmessage = null;
        this.worklet_node.disconnect();
        this.worklet_node = null;
    }
    if (this.source_node)
    {
        this.source_node.disconnect();
        this.source_node = null;
    }
    if (this.encoder)
    {
        try { this.encoder.close(); } catch (e) { }
        this.encoder = null;
    }
    if (this.stream)
    {
        this.stream.getTracks().forEach(function(t) { t.stop(); });
        this.stream = null;
    }
    if (this.audio_ctx)
    {
        this.audio_ctx.close().catch(function() { });
        this.audio_ctx = null;
    }
    this.raw_pending = [];
}

SpiceRecordConn.prototype.stop_capture = function()
{
    /* Invalidate in-flight async setup and late worklet/encoder callbacks
       before touching resources. */
    this.generation++;
    this.capturing = false;
    this.release_capture_resources();
}

SpiceRecordConn.prototype.cleanup = function()
{
    this.stop_capture();
    SpiceConn.prototype.cleanup.call(this);
}

export {
  SpiceRecordConn,
};
