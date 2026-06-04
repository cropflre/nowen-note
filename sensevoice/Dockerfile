ARG DOCKER_REGISTRY=docker.m.daocloud.io/
FROM ${DOCKER_REGISTRY}python:3.10-slim

WORKDIR /app

# Install git and ffmpeg (needed for audio file processing)
RUN apt-get update && apt-get install -y git ffmpeg && rm -rf /var/lib/apt/lists/*

# Install CPU versions of torch and torchaudio to keep memory foot print small
RUN pip install --no-cache-dir torch==2.2.2+cpu torchaudio==2.2.2+cpu --index-url https://download.pytorch.org/whl/cpu

# Install funasr and web api packages using Aliyun PyPI mirror and increased timeout
RUN pip install --no-cache-dir --default-timeout=1000 funasr fastapi python-multipart uvicorn "numpy<2.0" -i https://mirrors.aliyun.com/pypi/simple

COPY app.py .

EXPOSE 8000

CMD ["python", "app.py"]
