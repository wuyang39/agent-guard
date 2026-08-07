# syntax=docker/dockerfile:1
FROM python:3.12-slim@sha256:6da2590aca14d42e26e447add24777d223f865e2eaa6abaa97a5a8cfa003207c

RUN useradd --create-home --shell /bin/bash sandbox 2>/dev/null || true

USER sandbox
WORKDIR /home/sandbox

CMD ["sleep", "infinity"]
