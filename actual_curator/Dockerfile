# The Home Assistant app image: the published service image plus the options → env shim.
# Built and published by CI (home-assistant/builder actions), not on the device.
ARG APP_IMAGE=ghcr.io/shaiu/actual-curator:latest
FROM ${APP_IMAGE}

ARG BUILD_VERSION=dev
ARG BUILD_ARCH
LABEL io.hass.type="app" \
      io.hass.version="${BUILD_VERSION}" \
      io.hass.arch="${BUILD_ARCH}" \
      io.hass.name="Actual Curator" \
      org.opencontainers.image.source="https://github.com/shaiu/actual-curator"

COPY options.ts run.ts run.sh /app/ha/
CMD ["/app/ha/run.sh"]
