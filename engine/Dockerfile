FROM node:22-slim
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod
ENV NODE_ENV=production
USER node
# node directly, not `pnpm run`: pnpm reduces every non-zero exit to 1, and the 3 ("blind") must reach
# the restart policy intact.
CMD ["node", "dist/cli/main.js", "serve"]
