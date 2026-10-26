#!/usr/bin/env python3
"""asr_sensevoice.py — 用 sherpa-onnx + SenseVoice 做中文语音识别（不需要 torch）

用法:
    python asr_sensevoice.py <音频文件> [--model-dir D:\\dsh-video-tools\\models\\sensevoice]
也可被 import：recognize(wav_path, model_dir) -> str
"""
import argparse
import os
import sys
import wave

import numpy as np

DEFAULT_DIR = r"D:\dsh-video-tools\models\sensevoice"


def load_wav_16k(path):
    with wave.open(path, "rb") as w:
        rate = w.getframerate()
        ch = w.getnchannels()
        data = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
    if ch > 1:
        data = data.reshape(-1, ch).mean(axis=1)
    audio = data.astype(np.float32) / 32768.0
    if rate != 16000 and audio.size:
        want = int(round(audio.size * 16000 / rate))
        src = np.linspace(0.0, 1.0, audio.size, dtype=np.float32)
        dst = np.linspace(0.0, 1.0, want, dtype=np.float32)
        audio = np.interp(dst, src, audio).astype(np.float32)
    return audio


def build_recognizer(model_dir=DEFAULT_DIR):
    import sherpa_onnx

    model = os.path.join(model_dir, "model.int8.onnx")
    tokens = os.path.join(model_dir, "tokens.txt")
    if not (os.path.exists(model) and os.path.exists(tokens)):
        raise SystemExit(f"模型文件缺失: {model_dir}")
    return sherpa_onnx.OfflineRecognizer.from_sense_voice(
        model=model,
        tokens=tokens,
        num_threads=4,
        use_itn=True,
        language="zh",
    )


def recognize(audio, recognizer):
    stream = recognizer.create_stream()
    stream.accept_waveform(16000, audio)
    recognizer.decode_stream(stream)
    return stream.result.text.strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("--model-dir", default=DEFAULT_DIR)
    args = ap.parse_args()
    rec = build_recognizer(args.model_dir)
    text = recognize(load_wav_16k(args.audio), rec)
    print(text)


if __name__ == "__main__":
    main()
