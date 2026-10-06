import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    // No `sharp` binary in this deployment — the logo/brand assets are
    // small and local, so skip the optimization pipeline entirely.
    unoptimized: true,
  },
};

export default nextConfig;
