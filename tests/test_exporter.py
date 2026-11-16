# -*- coding: utf-8 -*-
"""
Timeline tests for ExportManager (exporter.py).

They cover the acceptance scenarios without needing pygame/librosa/ffmpeg:
  * normal playback -> natural end keeps the original behaviour
  * pause produces no frames and never advances the video timeline
  * resume after the mixer's get_pos() wall-clock jump continues smoothly
    (no one-shot dump of repeated frames)
  * early stop / track change: chapter ends follow the frames actually
    written and never exceed the video length
  * full end-to-end run with an in-process fake ffmpeg (raw pipe + mux)
    validates the exported frame count, chapter metadata and the unchanged
    ffmpeg call shape

Run with:  python -m pytest tests/ -v
(or simply: python tests/test_exporter.py)

tests/fake_ffmpeg.py is a standalone stub of the same behaviour for manual
runs on a machine without a real ffmpeg.
"""
import io
import os
import sys
import json
import shutil
import unittest
from contextlib import contextmanager
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import exporter
from exporter import ExportManager, MAX_FRAMES_PER_TICK, RESUME_JUMP_SECS

FPS = 60
W, H = 16, 8
FRAME = b"\x00" * (W * H * 3)


class FakePopen:
    """Stand-in for the raw-video ffmpeg encoder process.

    Real ffmpeg creates its output while consuming stdin and wait() only
    blocks until completion, so the frame count is computed when the writer
    thread closes stdin; wait() merely reports the exit code.
    """

    def __init__(self, cmd, stdin=None, stdout=None, stderr=None, **kwargs):
        self.cmd = cmd
        self._buf = io.BytesIO()
        size = cmd[cmd.index("-s") + 1]
        w, h = (int(x) for x in size.split("x"))
        self._frame_bytes = w * h * 3
        self._output = cmd[-1]
        self.frames_path = self._output + ".frames"
        with open(self._output, "wb") as f:      # output appears immediately
            f.write(b"FAKE-MP4")
        self.stdin = self._Stdin(self)
        self.returncode = None

    def wait(self):
        if self.returncode is None:              # stdin never closed
            self._finish()
        return self.returncode

    def _finish(self):
        frames = len(self._buf.getvalue()) // self._frame_bytes
        with open(self.frames_path, "w", encoding="utf-8") as f:
            f.write(str(frames))
        self.returncode = 0

    class _Stdin:
        def __init__(self, outer):
            self._outer = outer

        def write(self, data):
            return self._outer._buf.write(data)

        def close(self):
            self._outer._finish()
            return self._outer._buf.close()


def fake_run(cmd, **kwargs):
    """Stand-in for the mux subprocess.run(): copies the ffmetadata input."""
    output = cmd[-1]
    with open(output + ".cmd", "w", encoding="utf-8") as f:
        json.dump(cmd, f)
    inputs = []
    for i, a in enumerate(cmd):
        if a == "-i" and i + 1 < len(cmd):
            inputs.append(cmd[i + 1])
    for inp in inputs:
        if inp != "-" and os.path.exists(inp):
            with open(inp, "r", encoding="utf-8") as src:
                head = src.read()
            if head.startswith(";FFMETADATA1"):
                with open(output + ".meta", "w", encoding="utf-8") as dst:
                    dst.write(head)
                break
    with open(output, "wb") as f:
        f.write(b"FAKE-MUXED-MP4")
    return mock.Mock(returncode=0, stderr="")


@contextmanager
def fake_ffmpeg():
    with mock.patch.object(exporter.subprocess, "Popen", FakePopen), \
            mock.patch.object(exporter.subprocess, "run", fake_run):
        yield


def make_manager(tmpdir):
    cm = fake_ffmpeg()
    cm.__enter__()
    ex = ExportManager(out_dir=tmpdir, fps=FPS, ffmpeg_path="ffmpeg-fake")
    assert ex.start(W, H)
    ex._patch_cm = cm
    return ex


def pump(ex, fp, count, paused=False):
    """Simulate `count` render ticks with an exact 1-frame-per-tick audio clock
    (positions are integer frame times, so no floating-point drift)."""
    written = 0
    start = int(round(fp[0] * FPS))
    for tick in range(count):
        if not paused:
            fp[0] = (start + tick + 1) / FPS
        n = ex.frames_due(fp[0], paused=paused)
        if n > 0:
            ex.write(FRAME, n)
            written += n
    return written


class TimelineTests(unittest.TestCase):
    def setUp(self):
        self.tmp = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "_tmp_%d" % os.getpid())
        os.makedirs(self.tmp, exist_ok=True)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    # ------------------------------------------------------------ baseline
    def test_normal_playback_follows_audio_position(self):
        ex = make_manager(self.tmp)
        ex.begin_track("song.mp3", 10.0, "Song")
        fp = [0.0]
        written = pump(ex, fp, FPS * 2)          # two seconds of playback
        self.assertEqual(ex.frames, FPS * 2)
        self.assertEqual(written, FPS * 2)
        # timeline never runs ahead of the audio position
        self.assertLessEqual(ex.frames / FPS, fp[0] + 1.0 / FPS)
        self._drain_stop(ex)

    def test_natural_end_to_full_duration(self):
        """Natural end still tops the video up to the full song duration."""
        ex = make_manager(self.tmp)
        duration = 2.0
        ex.begin_track("song.mp3", duration, "Song")
        fp = [0.0]
        pump(ex, fp, FPS)                        # ~1 s written, then song ends
        ex.stop(natural_end=True)
        ex.wait()
        self.assertEqual(ex.frames, int(duration * FPS))
        self.assertTrue(os.path.exists(ex.final_path))
        # last chapter ends exactly at the video length
        starts, ends = self._chapters(ex)
        self.assertEqual(ends[-1], int(duration * 1000))
        ex._patch_cm.__exit__(None, None, None)

    # ------------------------------------------------------------ pause
    def test_pause_writes_no_frames_and_freezes_timeline(self):
        ex = make_manager(self.tmp)
        ex.begin_track("song.mp3", 10.0, "Song")
        fp = [0.0]
        pump(ex, fp, FPS)                        # 1 s of video
        frames_before = ex.frames

        for _ in range(FPS * 3):                 # 3 s paused, position frozen
            self.assertEqual(ex.frames_due(fp[0], paused=True), 0)
        self.assertEqual(ex.frames, frames_before)

        # mixer position still frozen: nothing is written either
        self.assertEqual(ex.frames_due(fp[0], paused=False), 0)
        self._drain_stop(ex)

    def test_resume_swallows_wallclock_jump_no_frame_burst(self):
        """get_pos() jumps by the paused wall-clock time on unpause."""
        ex = make_manager(self.tmp)
        ex.begin_track("song.mp3", 10.0, "Song")
        fp = [0.0]
        pump(ex, fp, FPS * 2)                    # 2 s played
        pause_pos = fp[0]

        for _ in range(FPS * 3):
            self.assertEqual(ex.frames_due(pause_pos, paused=True), 0)

        # First resumed tick: the mixer reports 5.0 s (2 s real + 3 s pause).
        # The jump must be swallowed and produce no burst of repeated frames.
        fp[0] = pause_pos + 3.0
        first = ex.frames_due(fp[0], paused=False)
        self.assertEqual(first, 0)
        self.assertEqual(ex.frames, FPS * 2)

        # From here the real audio clock advances one frame per render tick;
        # the video continues exactly where the pause froze it.
        pump(ex, fp, FPS * 2)                    # 2 more real seconds
        self.assertEqual(ex.frames, FPS * 4)     # pause seconds are absent
        self.assertEqual(fp[0], 4.0 + 3.0)       # raw clock still contains pause
        self._drain_stop(ex)

    def test_resume_without_jump_still_smooth(self):
        """Platforms whose get_pos() behaves correctly must not be affected."""
        ex = make_manager(self.tmp)
        ex.begin_track("song.mp3", 10.0, "Song")
        fp = [0.0]
        pump(ex, fp, FPS)
        pause_pos = fp[0]
        for _ in range(FPS):
            ex.frames_due(pause_pos, paused=True)
        # resumed position continues exactly where it stopped
        fp[0] = pause_pos
        n = ex.frames_due(fp[0], paused=False)
        self.assertEqual(n, 0)
        pump(ex, fp, FPS)
        self.assertEqual(ex.frames, FPS * 2)
        self._drain_stop(ex)

    def test_repeated_pause_resume_cycles(self):
        ex = make_manager(self.tmp)
        ex.begin_track("song.mp3", 30.0, "Song")
        fp = [0.0]
        pump(ex, fp, FPS)                        # 1 s real
        for _ in range(3):
            pos = fp[0]
            for _ in range(FPS // 2):
                self.assertEqual(ex.frames_due(pos, paused=True), 0)
            fp[0] = pos + 2.0                    # +2 s wall-clock jump
            n = ex.frames_due(fp[0], paused=False)
            self.assertLessEqual(n, 2)
            if n:
                ex.write(FRAME, n)
            pump(ex, fp, FPS)                    # 1 s real playback
        # only the 4 real seconds exist on the video timeline
        self.assertEqual(ex.frames, FPS * 4)
        self._drain_stop(ex)

    def test_small_resume_delta_is_not_treated_as_jump(self):
        ex = make_manager(self.tmp)
        ex.begin_track("song.mp3", 10.0, "Song")
        fp = [0.0]
        pump(ex, fp, FPS)
        for _ in range(3):
            ex.frames_due(fp[0], paused=True)
        # below RESUME_JUMP_SECS => ordinary audio progress, not a pause jump
        fp[0] += RESUME_JUMP_SECS / 2
        n = ex.frames_due(fp[0], paused=False)
        self.assertGreater(n, 0)
        ex.write(FRAME, n)
        self.assertAlmostEqual(ex.frames / FPS, fp[0], delta=1.0 / FPS)
        self._drain_stop(ex)

    # ------------------------------------------------- early stop / chapters
    def test_early_stop_chapter_ends_at_written_frames(self):
        ex = make_manager(self.tmp)
        ex.begin_track("song.mp3", 10.0, "Song")
        fp = [0.0]
        pump(ex, fp, FPS * 3)                    # only 3 of 10 s recorded
        frames = ex.frames
        self._drain_stop(ex)                     # plain, non-natural stop
        starts, ends = self._chapters(ex)
        self.assertEqual(starts[0], 0)
        self.assertEqual(ends[0], frames * 1000 // FPS)   # not 10 000 ms
        self.assertLessEqual(ends[0], frames * 1000 // FPS)

    def test_chapter_boundary_uses_written_frames_not_full_duration(self):
        ex = make_manager(self.tmp)
        ex.begin_track("first.mp3", 10.0, "First")
        fp = [0.0]
        pump(ex, fp, FPS * 2)                    # 2 s of track 1
        ex.begin_track("second.mp3", 8.0, "Second")   # cut track 1 short
        # new track starts at 0:00, exporter timeline must continue seamlessly
        self.assertEqual(ex._offset, ex.frames / FPS)
        fp[0] = 0.0
        pump(ex, fp, FPS)                        # 1 s of track 2
        frames = ex.frames
        self._drain_stop(ex)

        starts, ends = self._chapters(ex)
        self.assertEqual(starts, [0, FPS * 2 * 1000 // FPS])
        self.assertEqual(ends[0], starts[1])
        self.assertEqual(ends[1], frames * 1000 // FPS)
        # nothing reaches beyond the video that was actually written
        video_ms = frames * 1000 // FPS
        self.assertTrue(all(e <= video_ms for e in ends))

    def test_multiple_tracks_all_chapters_within_video(self):
        ex = make_manager(self.tmp)
        for k, dur in enumerate((4.0, 4.0, 4.0)):
            ex.begin_track("t%d.mp3" % k, dur, "Track %d" % k)
            fp = [0.0]
            pump(ex, fp, FPS * 2)                # 2 s per track, cut each short
        frames = ex.frames
        self._drain_stop(ex)
        starts, ends = self._chapters(ex)
        self.assertEqual(len(starts), 3)
        self.assertEqual(starts, [0, 2000, 4000])
        self.assertEqual(ends, [2000, 4000, frames * 1000 // FPS])
        self.assertTrue(all(e <= frames * 1000 // FPS for e in ends))

    # ------------------------------------------------------------ burst cap
    def test_single_tick_never_dumps_huge_block(self):
        ex = make_manager(self.tmp)
        ex.begin_track("song.mp3", 60.0, "Song")
        ex.frames_due(0.0)                        # prime position tracking
        # pathological 20 s jump that was NOT preceded by a pause
        n = ex.frames_due(20.0)
        self.assertLessEqual(n, MAX_FRAMES_PER_TICK)
        self._drain_stop(ex)

    # ------------------------------------------------------------ integration
    def test_end_to_end_pause_and_early_stop_with_fake_ffmpeg(self):
        ex = make_manager(self.tmp)
        track = os.path.join(self.tmp, "short.wav")
        with open(track, "wb") as f:
            f.write(b"RIFF....WAVEfake")
        ex.begin_track(track, 5.0, "Short Song")

        fp = [0.0]
        pump(ex, fp, FPS)                        # 1 s
        for _ in range(FPS * 2):                 # paused for 2 s
            ex.frames_due(fp[0], paused=True)
        fp[0] += 2.0                             # mixer jump at unpause
        ex.frames_due(fp[0], paused=False)       # swallowed, no burst
        pump(ex, fp, FPS)                        # another 1 s real playback

        recorded_frames = ex.frames
        self.assertEqual(recorded_frames, FPS * 2)
        self._drain_stop(ex)                     # early (manual) stop

        # temp video frame count == frames the manager counted
        with open(ex.temp_video + ".frames", encoding="utf-8") as f:
            self.assertEqual(int(f.read()), recorded_frames)

        # output exists and chapter metadata stays inside the video length
        self.assertTrue(os.path.exists(ex.final_path))
        starts, ends = self._chapters(ex)
        self.assertEqual(ends[-1], recorded_frames * 1000 // FPS)

        # ffmpeg call shape / naming conventions are untouched
        with open(ex.final_path + ".cmd", encoding="utf-8") as f:
            cmd = json.load(f)
        self.assertIn("-shortest", cmd)
        self.assertIn("copy", cmd)              # -c:v copy for the mux
        self.assertIn("-map_chapters", cmd)
        self.assertTrue(os.path.basename(ex.final_path).startswith("visualizer_"))

    # ------------------------------------------------------------ helpers
    def _drain_stop(self, ex, natural_end=False):
        """Stop (no natural-end top-up) and wait for finalisation."""
        ex.stop(natural_end=natural_end)
        ex.wait()
        self.assertFalse(ex.is_finalizing)
        self.assertEqual(ex._proc.returncode, 0)
        ex._patch_cm.__exit__(None, None, None)

    def _chapters(self, ex):
        with open(ex.final_path + ".meta", encoding="utf-8") as f:
            text = f.read()
        starts, ends = [], []
        block = None
        for line in text.splitlines():
            if line == "[CHAPTER]":
                block = {}
            elif block is not None and "=" in line:
                k, v = line.split("=", 1)
                block[k] = v
                if k == "title":
                    starts.append(int(block["START"]))
                    ends.append(int(block["END"]))
                    block = None
        return starts, ends


if __name__ == "__main__":
    unittest.main(verbosity=2)
