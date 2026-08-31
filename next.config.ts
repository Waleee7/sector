import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Pin the workspace root: there are sibling projects with their own lockfiles
  // above this directory, and Turbopack otherwise guesses.
  turbopack: { root: __dirname },
};

export default nextConfig;
