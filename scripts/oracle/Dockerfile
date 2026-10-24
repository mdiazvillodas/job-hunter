FROM mcr.microsoft.com/playwright:v1.62.1-noble
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends x11vnc novnc websockify && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/job-hunter
COPY package.json package-lock.json ./
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY scripts/oracle/start.sh /opt/job-hunter/start.sh
RUN chmod 755 /opt/job-hunter/start.sh
RUN mkdir -p /data && chown pwuser:pwuser /data
ENV NODE_PATH=/opt/job-hunter/node_modules PLAYWRIGHT_BROWSERS_PATH=/ms-playwright DISPLAY=:1 HOME=/data/home
USER pwuser
WORKDIR /data
ENTRYPOINT ["/opt/job-hunter/start.sh"]
