from pathlib import Path
import urllib.request
import os
import sys

MODEL_DIR = Path(__file__).resolve().parent / "models"
MODEL_PATH = MODEL_DIR / "BEN2_Base.onnx"
MODEL_URL = "https://huggingface.co/Prama/BEN2/resolve/main/BEN2_Base.onnx"

def ensure_model():
    if not MODEL_PATH.exists():
        MODEL_DIR.mkdir(parents=True, exist_ok=True)
        print(f"Downloading BEN2 model ({MODEL_PATH.name}) to {MODEL_DIR}...")
        try:
            urllib.request.urlretrieve(MODEL_URL, MODEL_PATH)
            print("Download complete!")
        except Exception as e:
            print(f"Failed to download model: {e}", file=sys.stderr)
            raise

if __name__ == "__main__":
    ensure_model()
