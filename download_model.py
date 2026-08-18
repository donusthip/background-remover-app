from pathlib import Path
import requests
import os
import sys

MODEL_DIR = Path(__file__).resolve().parent / "models"
MODEL_PATH = MODEL_DIR / "BEN2_Base.onnx"
MODEL_URL = "https://github.com/donusthip/background-remover-app/releases/download/v1.0/BEN2_Base.onnx"

def ensure_model():
    if not MODEL_PATH.exists():
        MODEL_DIR.mkdir(parents=True, exist_ok=True)
        print(f"Downloading BEN2 model ({MODEL_PATH.name}) from GitHub Release...")
        response = requests.get(MODEL_URL, stream=True, allow_redirects=True)
        response.raise_for_status()
        with open(MODEL_PATH, "wb") as f:
            for chunk in response.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    f.write(chunk)
        print("Download complete!")

if __name__ == "__main__":
    ensure_model()
