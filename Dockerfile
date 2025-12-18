# Using Apify's Playwright base image
FROM apify/actor-node-playwright-chrome:18

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Install Playwright browsers
RUN npx playwright install --with-deps chromium

# Copy source code
COPY . ./

# Start the actor
CMD npm start
