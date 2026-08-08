#!/usr/bin/env node
/**
 * Generate a JWT token for admin API access
 * 
 * Usage:
 *   ADMIN_JWT_SECRET="<your-strong-secret>" node scripts/generate-admin-jwt.ts
 * 
 * Or with tsx:
 *   ADMIN_JWT_SECRET="<your-strong-secret>" npx tsx scripts/generate-admin-jwt.ts
 */

import jwt from "jsonwebtoken";

const secret = process.env.ADMIN_JWT_SECRET;

if (!secret) {
  console.error("❌ Error: ADMIN_JWT_SECRET environment variable is required");
  console.error("");
  console.error("Usage:");
  console.error("  ADMIN_JWT_SECRET=<your-secret> node scripts/generate-admin-jwt.ts");
  process.exit(1);
}

if (secret.length < 32) {
  console.warn("⚠️  Warning: Secret is shorter than 32 characters. Use a strong secret!");
  console.warn("");
}

const token = jwt.sign(
  { 
    role: "admin", 
    iat: Math.floor(Date.now() / 1000) 
  },
  secret,
  { 
    expiresIn: "30d" 
  }
);

console.log("✅ Admin JWT Token generated successfully!");
console.log("");
console.log("Token:");
console.log(token);
console.log("");
console.log("Use this token in API requests:");
console.log(`  Authorization: Bearer ${token}`);
console.log("");
console.log("Token expires in: 30 days");
console.log("");
console.log("⚠️  Important: Keep this token secure and do not share it publicly!");
