-- phase: migrate
-- WebRTC recording through Media's RTP ingest (T4 decision 2 / brief §4.4). A webrtc session is
-- recorded by pointing a PlainRTP consumer at the RTP/RTCP port pair Media allocates; the
-- coordinator remembers the worker egress handle and the two ports so it can close the consumer on
-- finalize. Media's own RTP recorder needs codec info only at start, so nothing else changes here.
-- Never edited after it runs; a further change is a new migration.
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS rtp_handle text COLLATE "C";
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS rtp_video_port bigint;
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS rtp_audio_port bigint;
