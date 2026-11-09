# Container image for any host (AWS, Azure, GCP, Aptible, Fly.io...).
#   docker build -t clinic-ready .
#   docker run -p 3000:3000 -v clinic-data:/var/data \
#     -e EHR_ADMIN_EMAIL=you@clinic.com -e EHR_ADMIN_PASSWORD='a-strong-passphrase' clinic-ready
FROM node:22-alpine
ENV NODE_ENV=production EHR_DB_PATH=/var/data/ehr.sqlite PORT=3000
WORKDIR /app
COPY ehr/package.json ehr/package-lock.json ehr/
RUN cd ehr && npm ci --omit=dev
COPY *.html ./
COPY assets ./assets
COPY ehr ./ehr
RUN mkdir -p /var/data && chown -R node:node /var/data
USER node
EXPOSE 3000
VOLUME /var/data
HEALTHCHECK CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "--no-warnings", "ehr/server.js"]
