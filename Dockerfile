FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Download BEN2 ONNX model
RUN python download_model.py

ENV PORT=7860
ENV HOST=0.0.0.0
ENV MODEL_PATH=/app/models/BEN2_Base.onnx

EXPOSE 7860

CMD ["python", "app.py"]
