"use strict";
/*
   Copyright (C) 2026 by Eric Schultz <eric@startuperic.com>

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
**  videocodecs.js
**      Which stream codecs the browser's WebCodecs VideoDecoder can take,
**      probed once at load so the display channel can advertise them in
**      its link message, plus the per-codec bits the stream path needs.
**--------------------------------------------------------------------------*/

import { Constants } from './enums.js';

/* Codec strings for VideoDecoder.configure(). H.264 without a description
   is Annex B, which is what spice-server's x264 encoder emits. The VP9
   string names profile 0 8-bit; the level is informational. */
var VIDEO_CODEC_STRINGS = {};
VIDEO_CODEC_STRINGS[Constants.SPICE_VIDEO_CODEC_TYPE_VP8] = "vp8";
VIDEO_CODEC_STRINGS[Constants.SPICE_VIDEO_CODEC_TYPE_VP9] = "vp09.00.10.08";
VIDEO_CODEC_STRINGS[Constants.SPICE_VIDEO_CODEC_TYPE_H264] = "avc1.42E01E";

/* Filled by probe_video_codecs(); a codec is only advertised once its
   probe has said yes. */
var VideoCodecs = { supported: {} };

function probe_video_codecs()
{
    if (typeof VideoDecoder === "undefined")
        return;
    Object.keys(VIDEO_CODEC_STRINGS).forEach(function(type)
    {
        var codec = VIDEO_CODEC_STRINGS[type];
        try
        {
            VideoDecoder.isConfigSupported({ codec: codec, codedWidth: 640, codedHeight: 480 })
                .then(function(r) { VideoCodecs.supported[type] = !! r.supported; },
                      function() { VideoCodecs.supported[type] = false; });
        }
        catch (e)
        {
            VideoCodecs.supported[type] = false;
        }
    });
}

/* The VideoDecoder codec string for a SPICE codec type the browser has
   been probed to decode, else undefined. */
function video_decoder_codec(codec_type)
{
    return VideoCodecs.supported[codec_type] ? VIDEO_CODEC_STRINGS[codec_type] : undefined;
}

/* Whether a frame can start decoding. SPICE does not flag key frames, so
   read the bitstream: VP8's frame tag, VP9's uncompressed header, an IDR
   NAL in H.264 Annex B. */
function video_keyframe(codec_type, u8)
{
    if (u8.length == 0)
        return false;
    if (codec_type == Constants.SPICE_VIDEO_CODEC_TYPE_VP8)
        return (u8[0] & 1) == 0;
    if (codec_type == Constants.SPICE_VIDEO_CODEC_TYPE_VP9)
    {
        /* From the top bit down: frame_marker(2) profile_low(1)
           profile_high(1) [reserved(1) for profile 3] show_existing_frame(1)
           frame_type(1), where frame_type 0 is a key frame. */
        var profile = ((u8[0] >> 5) & 1) | (((u8[0] >> 4) & 1) << 1);
        var frame_type_bit = profile == 3 ? 1 : 2;
        var show_existing = (u8[0] >> (frame_type_bit + 1)) & 1;
        var frame_type = (u8[0] >> frame_type_bit) & 1;
        return show_existing == 0 && frame_type == 0;
    }
    if (codec_type == Constants.SPICE_VIDEO_CODEC_TYPE_H264)
    {
        for (var i = 0; i + 3 < u8.length; i++)
        {
            if (u8[i] == 0 && u8[i + 1] == 0 && u8[i + 2] == 1)
            {
                if ((u8[i + 3] & 0x1f) == 5)
                    return true;
                i += 2;
            }
        }
        return false;
    }
    return true;
}

probe_video_codecs();

export {
  VideoCodecs,
  video_decoder_codec,
  video_keyframe,
};
