FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    NUMBA_CACHE_DIR=/app/.numba-cache NUMBA_CPU_NAME=generic \
    MPLCONFIGDIR=/tmp/espresso-mpl PORT=8080
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
# Precompile the numba kernels into the image (cache dir must be writable by the runtime user).
RUN useradd --uid 10001 --no-create-home app \
 && LOCAL_DEV=true python -c "import main; main.warm_up_kernels()" \
 && chown -R app:app /app/.numba-cache
USER app
CMD exec uvicorn main:app --host 0.0.0.0 --port ${PORT} --workers 1
