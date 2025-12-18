# Using Apify's Playwright base image (browsers already installed)
FROM apify/actor-node-playwright-chrome:18

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY . ./

# Start the actor
CMD npm start
