FROM golang:1.23-bookworm AS go
FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates gcc libc6-dev && rm -rf /var/lib/apt/lists/*
COPY --from=go /usr/local/go /usr/local/go
ENV PATH="/usr/local/go/bin:${PATH}" GOFLAGS="-mod=mod" GOTOOLCHAIN=local GOPROXY="https://proxy.golang.org,direct"
RUN useradd -m runner
WORKDIR /app
COPY package.json server.js ./
USER runner
ENV GOPATH=/home/runner/go GOCACHE=/home/runner/.cache/go-build
EXPOSE 3000
CMD ["node", "server.js"]
