FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-bookworm-slim
ARG APP_VERSION=dev
ENV NODE_ENV=production PORT=3210 EASYX_DATA_DIR=/data EASYX_MEDIA_DIR=/media EASYX_EXTERNAL_PLUGINS_DIR=/plugins \
    EASYX_EMBEDDED_SUBTITLE_WORKER=true EASYX_SUBTITLE_PYTHON=/opt/subtitles/bin/python \
    EASYX_WHISPER_MODEL=small EASYX_TRANSLATION_MODEL=facebook/nllb-200-distilled-600M EASYX_SUBTITLE_CHUNK_SECONDS=600 \
    HF_HOME=/data/subtitle-models/huggingface PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 TOKENIZERS_PARALLELISM=false \
    APP_VERSION=${APP_VERSION}
ENV PATH=/opt/easyx/bin:/opt/ofscraper/bin:$PATH
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates chromium ffmpeg libimage-exiftool-perl novnc openbox python3 python3-venv python3-dev tini websockify x11vnc xvfb gcc g++ \
    && python3 -m venv /opt/easyx \
    && /opt/easyx/bin/pip install --no-cache-dir --upgrade pip "yt-dlp[default,curl-cffi]" gallery-dl \
    && python3 -m venv /opt/ofscraper \
    && /opt/ofscraper/bin/pip install --no-cache-dir --upgrade pip "ofscraper==3.14.7" \
    && python3 -m venv /opt/subtitles \
    && /opt/subtitles/bin/pip install --no-cache-dir --upgrade pip \
    && apt-get purge -y --auto-remove python3-dev gcc g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev
COPY requirements-subtitles.txt ./
RUN /opt/subtitles/bin/pip install --index-url https://download.pytorch.org/whl/cpu torch==2.9.1 \
    && /opt/subtitles/bin/pip install -r requirements-subtitles.txt
COPY --from=build /app/server ./server
COPY --from=build /app/plugins ./plugins
COPY --from=build /app/packages ./packages
COPY --from=build /app/dist ./dist
COPY worker ./worker
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
COPY scripts/easyx-ofscraper-download.mjs /usr/local/bin/easyx-ofscraper-download
COPY scripts/easyx-ofscraper-auth-test.py /usr/local/bin/easyx-ofscraper-auth-test
COPY scripts/easyx-browser-fetch.py /usr/local/bin/easyx-browser-fetch
COPY scripts/easyx-x-scrape.py /usr/local/bin/easyx-x-scrape
RUN chmod 0755 /app/docker-entrypoint.sh /usr/local/bin/easyx-ofscraper-download /usr/local/bin/easyx-ofscraper-auth-test /usr/local/bin/easyx-browser-fetch /usr/local/bin/easyx-x-scrape && mkdir -p /data /media /plugins
EXPOSE 3210
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["npm", "start"]
