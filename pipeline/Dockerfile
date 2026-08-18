# FPL/LMS pipeline — Railway cron service image.
# Build context is the REPO ROOT (so this file can reference pipeline/).
#   docker build -f pipeline/Dockerfile -t fpl-lms-pipeline .
# On Railway, set the service's Root Directory / Dockerfile path to pipeline/Dockerfile
# with the build context left at the repo root.
FROM python:3.12-slim

WORKDIR /app

# psql: used by the pre-deploy migration runner (db/migrate.sh) wired in
# railway.json. Kept as its own layer for build caching.
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client \
 && rm -rf /var/lib/apt/lists/*

# Install deps first for better layer caching.
COPY pipeline/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# App code.
COPY pipeline/ ./

# Schema + ordered migrations + the runner, so the Railway pre-deploy step
# (`sh db/migrate.sh`) can apply pending migrations before the cron serves.
COPY db ./db

CMD ["python", "run.py"]
