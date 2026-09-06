FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libgomp1 && rm -rf /var/lib/apt/lists/*
COPY requirements.txt ./
RUN pip install -r requirements.txt
COPY . .
# Silero VAD model and other plugin assets are fetched at build time, not on the first call.
RUN python agent.py download-files
RUN mkdir -p /app/data && chmod +x run.sh
VOLUME ["/app/data"]
# 8080 = test page + token endpoint, 8081 = LiveKit worker health
EXPOSE 8080 8081
CMD ["./run.sh"]
