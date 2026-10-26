#!/usr/bin/env python3
"""audio_helper.py — 录系统正在播放的声音，按块转写，追加到 transcript.txt

这是可选组件：没有 Python 或没有依赖时，插件的画面功能照常工作。

用法:
    python audio_helper.py --out <目录> [--chunk 20] [--model small] [--lang zh]
依赖:
    pip install pyaudiowpatch faster-whisper numpy
环境变量:
    HF_ENDPOINT / HF_HUB_DISABLE_XET 可指定模型镜像
"""
import argparse
import os
import queue
import re
import sys
import time
import wave

# Whisper 在纯音乐/静音上最爱编的几句，出现就当作幻觉丢掉
HALLUCINATION_HINTS = ('请不吝', '点赞', '订阅', '打赏', '转发', '字幕由', '明镜与点点', '谢谢观看')

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--chunk", type=float, default=20.0)
    ap.add_argument("--model", default="small")
    ap.add_argument("--lang", default="zh")
    ap.add_argument("--model-dir", default=None)
    args = ap.parse_args()

    import pyaudiowpatch as pyaudio
    import numpy as np
    from faster_whisper import WhisperModel

    os.makedirs(args.out, exist_ok=True)
    log_path = os.path.join(args.out, "transcript.txt")

    model = WhisperModel(args.model, device="cpu", compute_type="int8",
                         download_root=args.model_dir)

    p = pyaudio.PyAudio()
    wasapi = p.get_host_api_info_by_type(pyaudio.paWASAPI)
    dev = p.get_device_info_by_index(wasapi["defaultOutputDevice"])
    if not dev.get("isLoopbackDevice"):
        for lb in p.get_loopback_device_info_generator():
            if dev["name"] in lb["name"]:
                dev = lb
                break
    rate = int(dev["defaultSampleRate"])
    ch = min(2, int(dev["maxInputChannels"]))
    print(f"audio: {dev['name']} {rate}Hz {ch}ch", file=sys.stderr, flush=True)

    idx = 0
    while True:
        q = queue.Queue()

        def cb(in_data, frame_count, time_info, status):
            q.put(in_data)
            return (None, pyaudio.paContinue)

        stream = p.open(format=pyaudio.paInt16, channels=ch, rate=rate,
                        frames_per_buffer=1024, input=True,
                        input_device_index=dev["index"], stream_callback=cb)
        stream.start_stream()
        end_at = time.time() + args.chunk
        frames = []
        while time.time() < end_at:
            try:
                frames.append(q.get(timeout=0.5))
            except queue.Empty:
                pass
        stream.stop_stream()
        stream.close()

        if not frames:
            continue
        audio = np.frombuffer(b"".join(frames), dtype=np.int16)
        mono = audio.reshape(-1, ch).mean(axis=1).astype(np.float32) / 32768.0

        # Whisper 只吃 16k：设备给的是 44.1k/48k，直接喂进去等于放慢三倍，出来的全是乱码
        TARGET_RATE = 16000
        if rate != TARGET_RATE and mono.size:
            want = int(round(mono.size * TARGET_RATE / rate))
            if want > 1:
                src_axis = np.linspace(0.0, 1.0, mono.size, dtype=np.float32)
                dst_axis = np.linspace(0.0, 1.0, want, dtype=np.float32)
                mono = np.interp(dst_axis, src_axis, mono).astype(np.float32)
        if float(np.abs(mono).mean()) < 0.004:
            idx += 1
            continue
        try:
            segments, _ = model.transcribe(
                mono,
                language=args.lang,
                beam_size=5,
                vad_filter=True,
                vad_parameters={"threshold": 0.6, "min_silence_duration_ms": 500},
                condition_on_previous_text=False,
                no_speech_threshold=0.7,
                log_prob_threshold=-1.0,
            )
            pieces = []
            for seg in segments:
                # 置信度太低、或整段没检测到语音的，直接丢掉，防止它自己编
                if getattr(seg, "no_speech_prob", 0) > 0.6:
                    continue
                if getattr(seg, "avg_logprob", 0) < -1.3:
                    continue
                pieces.append(seg.text.strip())
            text = " ".join(pieces).strip()
        except Exception as exc:
            text = ""
            print(f"transcribe error: {exc}", file=sys.stderr, flush=True)
        if text and len(text) < 60 and any(h in text for h in HALLUCINATION_HINTS):
            print(f"drop hallucination: {text}", file=sys.stderr, flush=True)
            text = ""
        if text:
            with open(log_path, "a", encoding="utf-8") as f:
                f.write(f"[{time.strftime('%H:%M:%S')}] {text}\n")
                f.flush()
        idx += 1


if __name__ == "__main__":
    main()
