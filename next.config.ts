import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // CLAUDE.md is a governed project doc — don't let `next dev` append to it.
  agentRules: false,
};

export default nextConfig;
