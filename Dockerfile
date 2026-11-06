# Stage 1: build the command-centre web interface (React + TypeScript)
FROM node:20-slim AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend ./
RUN npx tsc --noEmit && npx vite build --outDir /web/dist --emptyOutDir

# Stage 2: the server
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY twin ./twin
COPY tools ./tools
COPY --from=web /web/dist ./twin/static/cc
ENV TWIN_DATA_DIR=/app/data
VOLUME /app/data
EXPOSE 8080
# One process only: live drone state is held in memory.
CMD ["uvicorn", "twin.app:app", "--host", "0.0.0.0", "--port", "8080", "--proxy-headers", "--forwarded-allow-ips", "*"]
