# FPL/LMS pipeline — Railway cron service image.
# Build context is the REPO ROOT (so this file can reference pipeline/).
#   docker build -f pipeline/Dockerfile -t fpl-lms-pipeline .
# On Railway, set the service's Root Directory / Dockerfile path to pipeline/Dockerfile
# with the build context left at the repo root.
FROM python:3.12-slim

WORKDIR /app

# Install deps first for better layer caching.
COPY pipeline/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# App code.
COPY pipeline/ ./

CMD ["python", "run.py"]
