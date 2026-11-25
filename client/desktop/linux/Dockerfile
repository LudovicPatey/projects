# Builds the Linux AppImage of the desktop client: npm run dist:linux (client/desktop/build-linux.mjs).
# Debian 11 has glibc 2.31: a program built against it runs on most distributions released since 2020.
FROM --platform=linux/amd64 node:20.18.1-bullseye

# Debian 11 is archived: its packages are on archive.debian.org.
RUN printf 'deb http://archive.debian.org/debian bullseye main\ndeb http://archive.debian.org/debian-security bullseye-security main\n' > /etc/apt/sources.list \
 && rm -f /etc/apt/sources.list.d/* \
 && apt-get -o Acquire::Check-Valid-Until=false update \
 && apt-get install -y --no-install-recommends python3 python3-venv python3-pip libpython3.9 binutils \
 && rm -rf /var/lib/apt/lists/*

# The sources are copied in, not mounted: the Mac's node_modules hold Mac binaries.
WORKDIR /work
COPY LICENSE /work/LICENSE
COPY client/oq.py /work/client/oq.py
COPY client/desktop/package.json client/desktop/package-lock.json /work/client/desktop/
WORKDIR /work/client/desktop
RUN npm ci --no-audit --no-fund
COPY client/desktop/main.js client/desktop/build-engine.mjs /work/client/desktop/
COPY client/desktop/assets /work/client/desktop/assets

# The engine (PyInstaller cannot build for Linux from a Mac), then the AppImage.
RUN node build-engine.mjs && npx electron-builder --linux AppImage --x64 --publish never
