import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: false, // double-mount in dev makes xterm fight itself
};

export default nextConfig;
