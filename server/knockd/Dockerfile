# knockd's image (D36), for Fly.io or any host that runs containers. It builds from the repo's root, which holds
# the Cargo workspace; the root's .dockerignore lets in only the workspace, so no secret reaches the build:
#   docker build -f server/knockd/Dockerfile .
FROM rust:1-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends cmake && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
RUN cargo build --release --locked -p knockd

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --no-create-home knockd
COPY --from=build /src/target/release/knockd /usr/local/bin/knockd
USER knockd
WORKDIR /home/knockd
# Its settings come from the environment: on Fly.io, fly.toml's [env] and `fly secrets set`.
ENV KNOCKD_ADDR=0.0.0.0:8080
EXPOSE 8080
CMD ["knockd"]
