# Build environment for build.sh, matching what upstream's CI installs on its Forgejo runner.
# Used by build-with-docker.sh to get a Linux build on a macOS host; CI uses the packages directly.
FROM ubuntu:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      ccache \
      cmake \
      curl \
      bison \
      flex \
      git \
      ninja-build \
      python3 \
      xz-utils \
    && rm -rf /var/lib/apt/lists/*

# build.sh applies our patch with `git -C llvm-src apply`, and git refuses to work in a tree owned by
# a different user, which a bind-mounted checkout always is.
RUN git config --system --add safe.directory '*'

WORKDIR /work
