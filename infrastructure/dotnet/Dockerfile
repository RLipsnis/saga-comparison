# syntax=docker/dockerfile:1.7
# ============================================================================
# Shared multi-stage Dockerfile for every .NET service in this repo.
#
#   docker build \
#     --build-arg PROJECT_PATH=src/Services/OrderService/OrderService.csproj \
#     --build-arg DLL_NAME=OrderService.dll \
#     -f infrastructure/dotnet/Dockerfile \
#     -t saga/order-service .
#
# Build context MUST be the repo root because every service references
# src/Shared/Shared.csproj.
# ============================================================================

# ── Build stage ─────────────────────────────────────────────────────────────
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build

# PROJECT_PATH is the path to the .csproj relative to the repo root.
ARG PROJECT_PATH

WORKDIR /src

# Copy the entire src tree so ProjectReference paths resolve.
COPY src/ ./src/

# Restore + publish only the requested project.
RUN dotnet restore "${PROJECT_PATH}"
RUN dotnet publish "${PROJECT_PATH}" -c Release -o /app/publish --no-restore

# ── Runtime stage ───────────────────────────────────────────────────────────
FROM mcr.microsoft.com/dotnet/aspnet:8.0 AS runtime

# DLL_NAME is the assembly produced by the publish stage, e.g. OrderService.dll.
ARG DLL_NAME

WORKDIR /app
COPY --from=build /app/publish ./

# curl is handy for healthchecks defined in docker-compose.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

ENV DLL_NAME=${DLL_NAME}
ENV ASPNETCORE_URLS=

# Shell-form CMD so $DLL_NAME is expanded at container start.
CMD exec dotnet "${DLL_NAME}"
