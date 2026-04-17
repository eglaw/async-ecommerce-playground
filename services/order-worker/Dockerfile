FROM debian:bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
    cmake g++ make pkg-config libssl-dev \
    librabbitmq-dev nlohmann-json3-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY CMakeLists.txt main.cpp ./
RUN cmake -S . -B build -DCMAKE_BUILD_TYPE=Release \
    && cmake --build build -j \
    && strip build/order-worker

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends librabbitmq4 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /src/build/order-worker .
CMD ["./order-worker"]
