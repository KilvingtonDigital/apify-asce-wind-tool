# Using Apify image with Puppeteer + Chrome pre-installed
FROM apify/actor-node-puppeteer-chrome:18
COPY package*.json ./
RUN npm install
COPY . ./
CMD npm start
