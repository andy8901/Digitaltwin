FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY twin ./twin
COPY tools ./tools
ENV TWIN_DATA_DIR=/app/data
VOLUME /app/data
EXPOSE 8080
# One process only: live drone state is held in memory.
CMD ["uvicorn", "twin.app:app", "--host", "0.0.0.0", "--port", "8080", "--proxy-headers", "--forwarded-allow-ips", "*"]
