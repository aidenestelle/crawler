# SemDash Crawler Worker Dockerfile
# Uses Playwright's official image with browsers pre-installed

FROM mcr.microsoft.com/playwright:v1.57.0-jammy

# Set working directory
WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

# Copy package files
COPY package.json pnpm-lock.yaml* ./

# Install dependencies
RUN pnpm install --frozen-lockfile || pnpm install

# Copy source code
COPY . .

# Build TypeScript
RUN pnpm run build

# Expose port (optional, for health checks)
EXPOSE 3000

# Set environment variables (these should be overridden at runtime)
ENV NODE_ENV=production
ENV SUPABASE_URL=""
ENV SUPABASE_SERVICE_KEY=""

# Run the crawler
CMD ["node", "dist/index.js"]
